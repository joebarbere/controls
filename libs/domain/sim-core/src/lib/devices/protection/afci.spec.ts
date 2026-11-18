import { replayEntries } from '@controls/commands';
import { BUILTIN_CATALOG, NEC_REGION } from '@controls/catalog';
import { deriveStream, entityPurposeStreamKey, worldHash } from '@controls/world-model';
import fc from 'fast-check';
import { SourceHost } from '../../../testing/sources';
import { LEAD_REF, NUT_REF } from '../../../testing/wired-loop';
import { afciBucket, afciDetectionBuckets, afciDraw, afciLimitS, afciLimitValues } from './afci';
import { AFCI_QUIET_RESET_TICKS } from './constants';
import { type AfciWhere, afciHost, afciMadeOhm } from '../../../testing/afci';

/*
 * The combination AFCI (P4 D8, ADR 0021 part 2). Hand calculations:
 *
 * - the region's limit (UL 1699 by number): 1 s at 5 A, under 0.2 s at 1.5 × the rating (22.5 A for a
 *   15 A breaker, 30 A for 20 A); between them the model interpolates linearly in rate (labelled
 *   interpolation): at 8 A on 15 A, 1 / (1 + 4 × 3 / 17.5) = 0.5932 s;
 * - each counted 100 ms bucket adds 1 / n to the exposure, n the whole buckets inside the limit (at
 *   least one; one fewer at a strict bound): n = 10 at 5 A, 5 at 8 A (0.5932 s), 1 from 22.5 A;
 * - the trip test u < (x − x_prev) / (1 − x_prev) makes the probability of no trip by bucket j exactly
 *   1 − x_j, so it reaches 1 by the bucket where x reaches 1: never later than the limit;
 * - below 5 A no bucket counts (n = 0): it never trips.
 *
 * In the engine: the utility stand-in (1); the 15 A AFCI (2) fed L1 → line, its pigtail to N; its load
 * through a THHN conductor between two wire nuts and a 12 Ω rheostat (5) back to its load neutral.
 * Arcing on the conductor end draws (120 − V_arc) / 12 ≈ 7.5–8.75 A. The upstream variant puts the
 * conductor between L1 and the AFCI's line instead. Hot spots are held at ambient (the connection
 * bank's test option), so a degraded end's regime is fixed for the run.
 */

const LIMITS = afciLimitValues(NEC_REGION.protection.afci);
const BUCKET_S = 0.1;

describe('the detection limit (D8)', () => {
  it('is 1 s at 5 A and 0.2 s at 1.5 × the rating; between, linear in rate (labelled interpolation), monotone', () => {
    expect(afciLimitS(5, 15, LIMITS)).toBe(1);
    expect(afciLimitS(22.5, 15, LIMITS)).toBe(0.2);
    expect(afciLimitS(30, 20, LIMITS)).toBe(0.2);
    expect(afciLimitS(8, 15, LIMITS)).toBeCloseTo(1 / (1 + (4 * 3) / 17.5), 12);
    expect(afciLimitS(4.999, 15, LIMITS)).toBe(Infinity);
    let previous = Infinity;
    for (let amps = 5; amps < 40; amps += 0.25) {
      const limit = afciLimitS(amps, 15, LIMITS);
      expect(limit).toBeLessThanOrEqual(previous);
      previous = limit;
    }
  });

  it('counts whole buckets inside it: 10 at 5 A, 5 at 8 A, 1 from 1.5 × rated (under 0.2 s), none below 5 A', () => {
    expect(afciDetectionBuckets(5, 15, LIMITS)).toBe(10);
    expect(afciDetectionBuckets(8, 15, LIMITS)).toBe(5);
    expect(afciDetectionBuckets(22.4, 15, LIMITS)).toBe(2);
    expect(afciDetectionBuckets(22.5, 15, LIMITS)).toBe(1);
    expect(afciDetectionBuckets(100, 20, LIMITS)).toBe(1);
    expect(afciDetectionBuckets(4.99, 15, LIMITS)).toBe(0);
    expect(afciDetectionBuckets(0, 15, LIMITS)).toBe(0);
  });
});

describe('the probabilistic trip (D8): within the limit for every seed (property)', () => {
  const run = (first: number, bucket0: number, currents: readonly number[], ratedA: number) => {
    let x = 0;
    for (let j = 0; j < currents.length; j++) {
      const n = afciDetectionBuckets(currents[j], ratedA, LIMITS);
      if (n === 0) continue;
      const step = afciBucket(x, n, afciDraw(first, bucket0 + j));
      x = step.x;
      if (step.trip) return { bucket: j + 1, x };
    }
    return { bucket: -1, x };
  };

  it('at a constant arc current ≥ 5 A it trips no later than the limit (strictly under 0.2 s from 1.5 × rated)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffffffff }),
        fc.nat({ max: 1_000_000 }),
        fc.double({ min: 5, max: 80, noNaN: true }),
        fc.constantFrom(15, 20),
        (first, bucket0, amps, ratedA) => {
          const { bucket } = run(first, bucket0, Array(20).fill(amps), ratedA);
          expect(bucket).toBeGreaterThan(0);
          const elapsed = bucket * BUCKET_S;
          const limit = afciLimitS(amps, ratedA, LIMITS);
          if (amps >= 1.5 * ratedA) expect(elapsed).toBeLessThan(limit);
          else expect(elapsed).toBeLessThanOrEqual(limit + 1e-12);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('with a varying arc current it trips by the bucket where the exposure reaches 1; never below 5 A', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffffffff }),
        fc.nat({ max: 1_000_000 }),
        fc.array(fc.double({ min: 0, max: 60, noNaN: true }), { minLength: 30, maxLength: 30 }),
        (first, bucket0, currents) => {
          const { bucket, x } = run(first, bucket0, currents, 15);
          let exposure = 0;
          let reached = -1;
          currents.forEach((amps, j) => {
            const n = afciDetectionBuckets(amps, 15, LIMITS);
            if (n > 0) exposure = Math.min(1, exposure + 1 / n);
            if (reached < 0 && exposure >= 1) reached = j + 1;
          });
          if (reached > 0) {
            expect(bucket).toBeGreaterThan(0);
            expect(bucket).toBeLessThanOrEqual(reached);
          }
          if (currents.every((a) => a < 5)) expect([bucket, x]).toStrictEqual([-1, 0]);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('the cumulative trip probability is the exposure: at n = 5, 20 %, 40 %, 60 %, 80 % by buckets 1–4, 100 % by 5', () => {
    const counts = [0, 0, 0, 0, 0, 0];
    const seeds = 20_000;
    for (let s = 0; s < seeds; s++) {
      const first = deriveStream(s, entityPurposeStreamKey(2, 'afci')).nextU32();
      counts[run(first, 4242, Array(5).fill(8), 15).bucket]++;
    }
    expect(counts[0]).toBe(0);
    let cumulative = 0;
    for (let j = 1; j <= 5; j++) {
      cumulative += counts[j];
      expect(Math.abs(cumulative / seeds - j / 5)).toBeLessThan(0.015);
    }
    expect(cumulative).toBe(seeds);
  });
});

describe('the AFCI breaker in a circuit (arcing ends from ADR 0018)', () => {
  type Where = AfciWhere;
  const madeOhm = afciMadeOhm;
  const host = afciHost;

  /** Advances bucket by bucket up to `buckets`, returning how many buckets the conductor's end A arced in, and the first arcFault trip. */
  function watch(h: SourceHost, buckets: number) {
    let arced = 0;
    for (let k = 0; k < buckets; k++) {
      h.advance(100);
      const conductor = h.engine.exportState().connections.find((c) => c.state['fused'] !== undefined);
      if (conductor?.state['endAState'] === 'arcing') arced++;
      const trip = h.events.find((e) => e.kind === 'tripped');
      if (trip) return { arced, trip };
    }
    return { arced, trip: undefined };
  }

  /** |I| (A) of connection `id`'s branch in the held solution, 0 when it isn't netlisted. */
  function conductorAmps(h: SourceHost, id: number): number {
    const branch = h.engine.netlist.branches.find(
      (b) => b.element.kind === 'connection' && b.element.connection === id,
    );
    if (branch === undefined) return 0;
    const s = h.engine.exportState().solution?.branches as number[];
    return Math.hypot(s[2 * branch.index], s[2 * branch.index + 1]);
  }

  /** Re-leads the circuit (the conductor between nuts 3 and 4 stays) so the conductor is on `where` of the AFCI. */
  function rewire(h: SourceHost, where: Where): void {
    for (const c of [...h.bus.state.connections]) if (c.lengthMm === null) h.exec('lead.disconnect', { id: c.id });
    const lead = (a: number, ta: string, b: number, tb: string) =>
      h.exec('lead.connect', { ref: LEAD_REF, a: { entity: a, terminal: ta }, b: { entity: b, terminal: tb } });
    lead(2, 'pigtail', 1, 'n');
    lead(5, 'b', 2, 'loadNeutral');
    if (where === 'downstream') {
      lead(1, 'l1', 2, 'line');
      lead(2, 'load', 3, 'splice');
      lead(4, 'splice', 5, 'a');
    } else {
      lead(1, 'l1', 3, 'splice');
      lead(4, 'splice', 2, 'line');
      lead(2, 'load', 5, 'a');
    }
  }

  it('end A at 0.4 Ω is intermittent and at 0.12 Ω glowing; the made contact is the twist-on’s', () => {
    expect(BUILTIN_CATALOG.device(NUT_REF)).toBeDefined();
    expect(madeOhm('downstream')).toBeGreaterThan(0);
    expect(madeOhm('downstream')).toBe(madeOhm('upstream'));
  });

  it('protocol 8: its record reads arcingDownstream exactly while a downstream end arcs, never upstream; arcExposure is its bag’s', () => {
    for (const where of ['downstream', 'upstream'] as const) {
      const h = host(where, 0.4, 3);
      let arcedSeen = 0;
      for (let k = 0; k < 40 && h.events.every((e) => e.kind !== 'tripped'); k++) {
        h.advance(100);
        const conductor = h.engine.exportState().connections.find((c) => c.state['fused'] !== undefined);
        const arcing = conductor?.state['endAState'] === 'arcing';
        const r = h.record(2);
        expect(r['arcExposure']).toBe(h.sim(2)['arcExposure']);
        if (r['state'] !== 'on') continue;
        if (arcing) arcedSeen++;
        expect(r['arcingDownstream'], `${where} bucket ${k}`).toBe(arcing && where === 'downstream' ? 'yes' : 'no');
      }
      expect(arcedSeen, where).toBeGreaterThan(0);
    }
  });

  it('trips (arcFault) on an arcing end downstream carrying ≥ 5 A, for every seed tried', () => {
    for (const seed of [1, 2, 3, 4]) {
      const h = host('downstream', 0.4, seed);
      const { arced, trip } = watch(h, 600);
      expect(trip?.detail['cause'], `seed ${seed}`).toBe('arcFault');
      expect(arced, `seed ${seed}`).toBeGreaterThan(0);
      expect((trip?.tick ?? 0) % 100, `seed ${seed}`).toBe(1);
      expect(h.sim(2)).toMatchObject({ tripped: true, tripCause: 'arcFault' });
    }
  });

  it('counts no more arcing buckets before the trip than fit inside the limit at the measured arc current', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const h = host('downstream', 0.4, seed);
      let counted = 0;
      let smallest = Infinity;
      let tripped = false;
      for (let k = 0; k < 600 && !tripped; k++) {
        // At a boundary tick B the engine holds bucket B − 1's end state and its solution; step B judges it.
        const arcing = h.engine.exportState().connections.find((c) => c.id === 4)?.state['endAState'] === 'arcing';
        const amps = arcing ? conductorAmps(h, 4) : 0;
        const boundary = h.engine.tick;
        h.advance(100);
        const bag = h.sim(2);
        tripped = bag['tripped'] === true;
        if (bag['arcLastSeenTick'] === boundary) {
          counted++;
          smallest = Math.min(smallest, amps);
          expect(amps, `seed ${seed}`).toBeGreaterThanOrEqual(5);
        } else if (bag['arcLastSeenTick'] === null) {
          counted = 0;
          smallest = Infinity;
        }
      }
      expect(tripped, `seed ${seed}`).toBe(true);
      expect(counted, `seed ${seed}`).toBeGreaterThan(0);
      expect(counted, `seed ${seed}`).toBeLessThanOrEqual(afciDetectionBuckets(smallest, 15, LIMITS));
    }
  });

  it('the exposure follows a rewire: an arcing conductor moved from the load side to the line side stops counting, and back', () => {
    const h = host('downstream', 0.4, 3);
    for (let k = 0; k < 600 && (h.sim(2)['arcExposure'] as number) === 0; k++) h.advance(100);
    expect(h.sim(2)).toMatchObject({ tripped: false });
    const before = h.sim(2)['arcExposure'] as number;
    expect(before).toBeGreaterThan(0);
    // Upstream: L1 → nut 3, the conductor, nut 4 → the AFCI's line; the load straight off its load screw.
    rewire(h, 'upstream');
    const upstream = watch(h, 300);
    expect(upstream.arced).toBeGreaterThan(10);
    expect(upstream.trip).toBeUndefined();
    expect(h.sim(2)).toMatchObject({ arcExposure: 0, arcLastSeenTick: null, tripped: false });
    // And back downstream: it counts again, and trips.
    rewire(h, 'downstream');
    const downstream = watch(h, 600);
    expect(downstream.trip?.detail['cause']).toBe('arcFault');
  });

  it('save, load and replay equal the straight run over random AFCI arcing sessions (property)', () => {
    type Op =
      | { kind: 'advance'; ticks: number }
      | { kind: 'rewire'; to: Where }
      | { kind: 'handle'; on: boolean }
      | { kind: 'press' }
      | { kind: 'load'; ohms: number };
    const opArb: fc.Arbitrary<Op> = fc.oneof(
      {
        weight: 5,
        arbitrary: fc.record({ kind: fc.constant('advance' as const), ticks: fc.integer({ min: 1, max: 1500 }) }),
      },
      {
        weight: 1,
        arbitrary: fc.record({
          kind: fc.constant('rewire' as const),
          to: fc.constantFrom<Where>('downstream', 'upstream'),
        }),
      },
      { weight: 1, arbitrary: fc.record({ kind: fc.constant('handle' as const), on: fc.boolean() }) },
      { weight: 1, arbitrary: fc.constant({ kind: 'press' as const }) },
      { weight: 1, arbitrary: fc.record({ kind: fc.constant('load' as const), ohms: fc.constantFrom(12, 40) }) },
    );
    const apply = (h: SourceHost, op: Op) => {
      if (op.kind === 'advance') h.advance(op.ticks);
      else if (op.kind === 'rewire') rewire(h, op.to);
      else if (op.kind === 'handle') h.operate(2, 'on', op.on);
      else if (op.kind === 'press') h.exec('device.press', { id: 2, control: 'test' });
      else h.operate(5, 'ohms', op.ohms);
    };
    const fingerprint = (h: SourceHost) => ({
      tick: h.engine.tick,
      snapshot: h.engine.snapshotHash(),
      world: worldHash(h.materialised()),
    });
    let arcTrips = 0;
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1000 }),
        fc.array(opArb, { minLength: 1, maxLength: 5 }),
        fc.array(opArb, { minLength: 1, maxLength: 5 }),
        (seed, before, after) => {
          const straight = host('downstream', 0.4, seed);
          before.forEach((op) => apply(straight, op));
          const loaded = straight.reload();
          straight.bus.clearHistory();
          straight.events.length = 0;
          for (const op of after) {
            apply(straight, op);
            apply(loaded, op);
          }
          expect(loaded.events).toStrictEqual(straight.events);
          expect(fingerprint(loaded)).toStrictEqual(fingerprint(straight));
          // A replay of the whole log from the start reaches the same bytes and events.
          const live = host('downstream', 0.4, seed);
          [...before, ...after].forEach((op) => apply(live, op));
          const replay = host('downstream', 0.4, seed);
          expect(
            replayEntries(replay.bus, live.bus.entries, { time: replay.engine, endTick: live.engine.tick }),
          ).toStrictEqual({ ok: true });
          replay.events.push(...replay.engine.takeEvents());
          expect(replay.events).toStrictEqual(live.events);
          expect(fingerprint(replay)).toStrictEqual(fingerprint(live));
          arcTrips += live.events.filter((e) => e.kind === 'tripped' && e.detail['cause'] === 'arcFault').length;
        },
      ),
      { numRuns: 12, seed: 20261118 },
    );
    // Generator health: the sessions do reach arc-fault trips.
    expect(arcTrips).toBeGreaterThan(0);
  });

  it('never trips on an arcing end that is not downstream (on its line side)', () => {
    const h = host('upstream', 0.4, 1);
    const { arced, trip } = watch(h, 300);
    expect(arced).toBeGreaterThan(10);
    expect(trip).toBeUndefined();
    expect(h.sim(2)).toMatchObject({ arcExposure: 0, arcLastSeenTick: null, tripped: false });
  });

  it('never trips on a degraded, glowing joint that is not arcing', () => {
    const h = host('downstream', 0.12, 1);
    const { arced, trip } = watch(h, 200);
    expect(arced).toBe(0);
    expect(trip).toBeUndefined();
    expect(h.sim(2)['arcExposure']).toBe(0);
  });

  it('never trips on arcing below 5 A (a 40 Ω load, ≈ 2.5 A)', () => {
    const h = host('downstream', 0.4, 1, 40);
    const { arced, trip } = watch(h, 200);
    expect(arced).toBeGreaterThan(5);
    expect(trip).toBeUndefined();
  });

  it('forgets its exposure a quiet gap after the last arcing bucket', () => {
    const h = host('downstream', 0.4, 3);
    for (let k = 0; k < 600 && (h.sim(2)['arcExposure'] as number) === 0; k++) h.advance(100);
    const seen = h.sim(2)['arcLastSeenTick'] as number;
    expect(seen).toBeGreaterThan(0);
    expect(h.sim(2)['tripped']).toBe(false);
    // Take the arcing conductor out (its downstream load disconnected): nothing arcs downstream any more.
    h.exec('lead.disconnect', { id: 5 });
    h.advanceTo(seen + AFCI_QUIET_RESET_TICKS.value + 1);
    expect(h.sim(2)).toMatchObject({ arcExposure: 0, arcLastSeenTick: null });
  });

  it('a save and load mid-exposure trips at the same tick as the straight run (pure in seed, id, bucket and the keys)', () => {
    const straight = host('downstream', 0.4, 2);
    for (let k = 0; k < 600 && (straight.sim(2)['arcExposure'] as number) === 0; k++) straight.advance(100);
    straight.advance(37);
    const loaded = straight.reload();
    const a = watch(straight, 600);
    const b = watch(loaded, 600);
    expect(b.trip).toStrictEqual(a.trip);
    expect(loaded.engine.snapshotHash()).toBe(straight.engine.snapshotHash());
    expect(worldHash(loaded.materialised())).toBe(worldHash(straight.materialised()));
  });

  it('the test button trips it at once (cause test) when closed and powered; with the handle off it does nothing', () => {
    const h = host('downstream', 1, 1);
    h.advance(10);
    h.exec('device.press', { id: 2, control: 'test' });
    expect(h.events.at(-1)).toMatchObject({ kind: 'tripped', tick: 10, entity: 2, detail: { cause: 'test' } });
    expect(h.sim(2)).toMatchObject({ tripped: true, tripCause: 'test' });
    h.operate(2, 'on', false);
    h.exec('device.press', { id: 2, control: 'test' });
    expect(h.sim(2)).toMatchObject({ tripped: false, tripCause: null });
    expect(h.events.filter((e) => e.kind === 'tripped')).toHaveLength(1);
  });
});

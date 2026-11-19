import { ENGINE_TEST_CATALOG, ENGINE_TEST_MODELS } from '../../../testing/engine';
import { AC_SOURCE } from '../../../testing/bench';
import {
  A19_60W,
  LAMPHOLDER,
  PULL_CHAIN,
  socket,
  SWITCH_1P,
  SWITCH_3WAY,
  SWITCH_4WAY,
} from '../../../testing/lighting';
import { SourceHost } from '../../../testing/sources';
import { wiringGraph } from '../../netlist/wiring-graph';
import { DEVICE_NETLIST_MODELS } from '../../netlist/models';

/*
 * P4 F4.1 part 1's switch goldens (plan F4.1: "3-way and 4-way truth tables on a bench circuit"). The
 * bench: the 120 V test AC source (1, behind 0.1 Ω) feeds switch S1's common; S1's travellers run to
 * S2's (t1 to t1, t2 to t2, or through a 4-way's a and b pairs); S2's common feeds a keyless E26
 * lampholder's brass screw, its silver screw returns to the source; a 60 W A19 bulb (the P3 120 V
 * filament) is screwed in. Every link is the 41 mΩ bench test lead (a near-zero busbar would make a
 * dead traveller's current rounding over 17 nΩ, not 0).
 *
 * Hand truth tables: with t1 wired to t1, the common-to-common path is closed exactly when both
 * switches select the same traveller (a 3-way pair is lit when the positions agree; which positions
 * a player calls "different" depends only on which traveller lands on which screw). A 4-way between
 * them passes the travellers straight or swaps them, so the lamp is lit exactly when
 * (S1 = S2) XOR (4-way crossed): all eight states. When lit the lamp settles at about 0.5 A (its 240 Ω
 * hot resistance on 120 V), and only the selected traveller carries it; when dark the lamp carries
 * nothing.
 */

const LIT_A = 0.4;
/** "No current": far below any reading, far above the solver's rounding over a 41 mΩ lead. */
const DARK_A = 1e-9;

interface Bench {
  readonly host: SourceHost;
  readonly s1: number;
  readonly s2: number;
  readonly four: number | null;
  readonly bulb: number;
  /** Connection ids of the two travellers on S1's side (t1, t2). */
  readonly travellers: readonly [number, number];
}

function link(host: SourceHost, a: number, ta: string, b: number, tb: string): number {
  host.lead(a, ta, b, tb);
  return host.bus.state.nextConnectionId - 1;
}

function bench(fourWay: boolean): Bench {
  const host = new SourceHost();
  const source = host.place(AC_SOURCE);
  const s1 = host.place(SWITCH_3WAY);
  const four = fourWay ? host.place(SWITCH_4WAY) : null;
  const s2 = host.place(SWITCH_3WAY);
  const { holder, bulb } = socket(host, A19_60W);
  link(host, source, 'l', s1, 'common');
  let travellers: [number, number];
  if (four === null) {
    travellers = [link(host, s1, 't1', s2, 't1'), link(host, s1, 't2', s2, 't2')];
  } else {
    travellers = [link(host, s1, 't1', four, 'a1'), link(host, s1, 't2', four, 'a2')];
    link(host, four, 'b1', s2, 't1');
    link(host, four, 'b2', s2, 't2');
  }
  link(host, s2, 'common', holder, 'hot');
  link(host, holder, 'neutral', source, 'n');
  return { host, s1, s2, four, bulb, travellers };
}

/** |I| through a connection (A) in the engine's solution, 0 when it isn't netlisted. */
function connectionAmps(host: SourceHost, id: number): number {
  return host.engine.branchAmps({ kind: 'connection', connection: id }) || 0;
}

const lampAmps = (b: Bench): number =>
  b.host.engine.branchAmps({ kind: 'entity', entity: b.bulb, part: 'filament' }) || 0;

describe('the 3-way and 4-way switches on a bench circuit (F4.1 part 1 golden)', () => {
  it('a 3-way pair: lit exactly when both select the same traveller, and only that traveller carries the lamp', () => {
    const rows: string[] = [];
    for (const p1 of ['t1', 't2'] as const) {
      for (const p2 of ['t1', 't2'] as const) {
        const b = bench(false);
        b.host.operate(b.s1, 'position', p1).operate(b.s2, 'position', p2).advance(400);
        const lit = p1 === p2;
        const amps = lampAmps(b);
        rows.push(`${p1} ${p2} ${lit ? 'lit' : 'dark'}`);
        if (lit) {
          expect(amps).toBeGreaterThan(LIT_A);
          expect(Math.abs(amps / 0.5 - 1)).toBeLessThan(0.01);
          const selected = connectionAmps(b.host, b.travellers[p1 === 't1' ? 0 : 1]);
          const other = connectionAmps(b.host, b.travellers[p1 === 't1' ? 1 : 0]);
          expect(Math.abs(selected / amps - 1)).toBeLessThan(1e-6);
          expect(other).toBeLessThan(DARK_A);
          expect(b.host.record(b.bulb)['lightOutputRel']).toBeGreaterThan(0.95);
        } else {
          expect(amps).toBeLessThan(DARK_A);
          for (const t of b.travellers) expect(connectionAmps(b.host, t)).toBeLessThan(DARK_A);
          expect(b.host.record(b.bulb)['lightOutputRel']).toBeLessThan(1e-9);
        }
      }
    }
    expect(rows).toStrictEqual(['t1 t1 lit', 't1 t2 dark', 't2 t1 dark', 't2 t2 lit']);
  });

  it('a 4-way between them: all eight states, lit exactly when (S1 = S2) XOR crossed', () => {
    const rows: string[] = [];
    for (const p1 of ['t1', 't2'] as const) {
      for (const p4 of ['straight', 'crossed'] as const) {
        for (const p2 of ['t1', 't2'] as const) {
          const b = bench(true);
          b.host
            .operate(b.s1, 'position', p1)
            .operate(b.four as number, 'position', p4)
            .operate(b.s2, 'position', p2)
            .advance(400);
          const lit = (p1 === p2) !== (p4 === 'crossed');
          rows.push(`${p1} ${p4} ${p2} ${lit ? 'lit' : 'dark'}`);
          const amps = lampAmps(b);
          if (lit) {
            expect(Math.abs(amps / 0.5 - 1)).toBeLessThan(0.01);
            expect(Math.abs(connectionAmps(b.host, b.travellers[p1 === 't1' ? 0 : 1]) / amps - 1)).toBeLessThan(1e-6);
            expect(connectionAmps(b.host, b.travellers[p1 === 't1' ? 1 : 0])).toBeLessThan(DARK_A);
          } else {
            expect(amps).toBeLessThan(DARK_A);
          }
        }
      }
    }
    expect(rows.filter((r) => r.endsWith('lit'))).toStrictEqual([
      't1 straight t1 lit',
      't1 crossed t2 lit',
      't2 straight t2 lit',
      't2 crossed t1 lit',
    ]);
  });

  it('flipping either switch of a lit 3-way pair turns the lamp off at the command tick, and back on', () => {
    const b = bench(false);
    b.host.advance(400);
    expect(lampAmps(b)).toBeGreaterThan(LIT_A);
    const tick = b.host.engine.tick;
    b.host.operate(b.s2, 'position', 't2');
    expect(b.host.engine.lastSolveTick).toBe(tick);
    expect(lampAmps(b)).toBeLessThan(DARK_A);
    b.host.operate(b.s1, 'position', 't2');
    expect(lampAmps(b)).toBeGreaterThan(LIT_A);
  });

  it('a single-pole switch: closed lights the lamp, open darkens it; its ground screw joins nothing', () => {
    const host = new SourceHost();
    const source = host.place(AC_SOURCE);
    const sw = host.place(SWITCH_1P);
    const { holder, bulb } = socket(host, A19_60W);
    link(host, source, 'l', sw, 'a');
    link(host, sw, 'b', holder, 'hot');
    link(host, holder, 'neutral', source, 'n');
    const amps = () => host.engine.branchAmps({ kind: 'entity', entity: bulb, part: 'filament' }) || 0;
    host.advance(400);
    expect(amps()).toBeLessThan(DARK_A);
    host.operate(sw, 'closed', true).advance(400);
    expect(Math.abs(amps() / 0.5 - 1)).toBeLessThan(0.01);
    const nodes = host.engine.netlist.nodes;
    const nodeOf = (entity: number, terminal: string) =>
      nodes.findIndex((n) => n.members.some((m) => m.entity === entity && m.terminal === terminal));
    expect(nodeOf(sw, 'a')).toBe(nodeOf(sw, 'b'));
    expect(nodes[nodeOf(sw, 'ground')].members).toStrictEqual([{ entity: sw, terminal: 'ground' }]);
    host.operate(sw, 'closed', false);
    expect(amps()).toBeLessThan(DARK_A);
  });

  it('a pull-chain holder: open draws nothing, closed equals the keyless holder; a save closed reloads closed', () => {
    const lit = (holderRef: typeof PULL_CHAIN) => {
      const host = new SourceHost();
      const source = host.place(AC_SOURCE);
      const { holder, bulb } = socket(host, A19_60W, holderRef);
      link(host, source, 'l', holder, 'hot');
      link(host, holder, 'neutral', source, 'n');
      return { host, holder, bulb };
    };
    const amps = (h: SourceHost, bulb: number) =>
      h.engine.branchAmps({ kind: 'entity', entity: bulb, part: 'filament' }) || 0;
    const keyless = lit(LAMPHOLDER);
    keyless.host.advance(400);
    const chain = lit(PULL_CHAIN);
    chain.host.advance(400);
    expect(amps(chain.host, chain.bulb)).toBeLessThan(DARK_A);
    expect(chain.host.record(chain.bulb)['lightOutputRel']).toBeLessThan(1e-9);
    // The bulb's centre contact lands on the sealed `centre` node, apart from the brass screw while open.
    const nodes = chain.host.engine.netlist.nodes;
    const nodeOf = (entity: number, terminal: string) =>
      nodes.findIndex((n) => n.members.some((m) => m.entity === entity && m.terminal === terminal));
    expect(nodeOf(chain.holder, 'centre')).not.toBe(nodeOf(chain.holder, 'hot'));
    // Closed at the same tick the keyless lamp was lit, the two run identically.
    const closed = lit(PULL_CHAIN);
    closed.host.operate(closed.holder, 'closed', true).advance(400);
    expect(amps(closed.host, closed.bulb)).toBe(amps(keyless.host, keyless.bulb));
    expect(closed.host.record(closed.bulb)).toStrictEqual(keyless.host.record(keyless.bulb));
    expect(Math.abs(amps(closed.host, closed.bulb) / 0.5 - 1)).toBeLessThan(0.01);
    // Saved closed, it reloads closed and lit.
    const reloaded = closed.host.reload();
    expect(reloaded.bus.state.entities.find((e) => e.id === closed.holder)?.state).toStrictEqual({ closed: true });
    reloaded.advance(20);
    expect(Math.abs(amps(reloaded, closed.bulb) / 0.5 - 1)).toBeLessThan(0.01);
    // Pulled again: dark at the command's tick.
    reloaded.operate(closed.holder, 'closed', false);
    expect(amps(reloaded, closed.bulb)).toBeLessThan(DARK_A);
  });

  it('the wiring view joins every switch position (switching devices closed, D13)', () => {
    const b = bench(true);
    const graph = wiringGraph(b.host.bus.state, ENGINE_TEST_CATALOG, { models: ENGINE_TEST_MODELS });
    const t = (entity: number, terminal: string) => ({ entity, terminal });
    expect(graph.joined(t(b.s1, 'common'), t(b.s1, 't1'))).toBe(true);
    expect(graph.joined(t(b.s1, 'common'), t(b.s1, 't2'))).toBe(true);
    expect(graph.joined(t(b.four as number, 'a1'), t(b.four as number, 'b2'))).toBe(true);
    // The lamp is a load, never a path: the source's line and neutral stay apart.
    expect(graph.joined(t(1, 'l'), t(1, 'n'))).toBe(false);
    expect(graph.joined(t(1, 'l'), t(b.bulb, 'a'))).toBe(true);
  });

  it('the netlist models: each switch position, and an unknown position falls back to the first', () => {
    const top = (kind: string, state: Record<string, unknown>) =>
      DEVICE_NETLIST_MODELS[kind].topology({ params: {}, state: state as never, sim: {} }).joins;
    expect(top('switch.wall1p', { closed: true })).toStrictEqual([['a', 'b']]);
    expect(top('switch.wall1p', { closed: false })).toStrictEqual([]);
    expect(top('switch.wall3way', { position: 't1' })).toStrictEqual([['common', 't1']]);
    expect(top('switch.wall3way', { position: 't2' })).toStrictEqual([['common', 't2']]);
    expect(top('switch.wall4way', { position: 'straight' })).toStrictEqual([
      ['a1', 'b1'],
      ['a2', 'b2'],
    ]);
    expect(top('switch.wall4way', { position: 'crossed' })).toStrictEqual([
      ['a1', 'b2'],
      ['a2', 'b1'],
    ]);
    expect(top('switch.wall3way', {})).toStrictEqual([['common', 't1']]);
    const wiring = (kind: string) =>
      DEVICE_NETLIST_MODELS[kind].wiring?.({ params: {}, state: {}, sim: {} }).joins ?? null;
    expect(wiring('switch.wall1p')).toStrictEqual([['a', 'b']]);
    expect(wiring('switch.wall3way')).toStrictEqual([['common', 't1', 't2']]);
    expect(wiring('switch.wall4way')).toStrictEqual([['a1', 'a2', 'b1', 'b2']]);
    expect(DEVICE_NETLIST_MODELS['lampholder.e26'].topology({ params: {}, state: {}, sim: {} })).toStrictEqual({
      joins: [],
      elements: [],
    });
    expect(top('lampholder.e26PullChain', { closed: true })).toStrictEqual([['centre', 'hot']]);
    expect(top('lampholder.e26PullChain', { closed: false })).toStrictEqual([]);
    expect(wiring('lampholder.e26PullChain')).toStrictEqual([['centre', 'hot']]);
    expect(DEVICE_NETLIST_MODELS['lampholder.e26PullChain'].simTopologyKeys).toStrictEqual([]);
  });
});

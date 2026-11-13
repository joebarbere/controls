import { BUILTIN_CATALOG, TerminalMethodSpec } from '@controls/catalog';
import type { TerminationV3 } from '@controls/save-format';
import { autoTermination } from '@controls/world-model';
import fc from 'fast-check';
import {
  AL_UNRATED_DEGRADATION_MULTIPLIER,
  CRIMP_GOOD_OHM,
  LOOSE_FILM_OHM,
  NICK_MAX_FRACTION,
  SEAT_FRACTION,
  STRAND_SPREAD_FACTOR,
  TERMINAL_RESISTIVITY_OHM_M,
} from './constants';
import {
  asMadeContact,
  asMadeContactInto,
  clampResistanceOhm,
  type ContactConductor,
  type ContactEnd,
  crimpResistanceOhm,
  degradationRateMultiplier,
  effectiveClampRatio,
  metalContactFactor,
  nickFactor,
  torqueRatio,
} from './contact';

/*
 * ADR 0018 §12, F3.3 part 1 contact goldens (headless). R₀ = 0.3 mΩ test entries, copper, at T₀.
 * Each golden's hand calculation is written beside it; the tolerance is 0.5 % or tighter (most are
 * exact to 1e-12 relative, since the model is a handful of IEEE operations).
 *
 * The law (ADR 0018 §4.2–4.3), with r_seat = 0.4 and R_loose = 100 mΩ:
 *   R_clamp(r) = R₀ / √(clamp(r, 0.4, 1)) + 100 mΩ · (max(0, 1 − r/0.4))²
 *   r_eff = r × min(1, strip/clampDepth) × (rated/n if n > rated) × (0.5 if bare stranded under a binding screw)
 *   R_made = (R_clamp(r_eff) · m + R_crimp(q)) / (1 − min(f, 0.9)),  m = (ρ + ρ_Cu)/(2ρ_Cu)
 */

const COPPER: ContactConductor = { stranding: 'solid', resistivityOhmM: 1.724137931034483e-8 };
const COPPER_STRANDED: ContactConductor = { stranding: 'stranded', resistivityOhmM: 1.724137931034483e-8 };
const ALUMINIUM: ContactConductor = { stranding: 'stranded', resistivityOhmM: 2.8264e-8 };

const base = {
  ratedConductors: 1,
  maxConductors: 2,
  awgRange: { smallest: 14, largest: 10 },
  stranding: ['solid', 'stranded', 'strandedFerrule'],
  stripLengthMm: { nominal: 13, tolerance: 2 },
  alRated: false,
  entryMm: { x: 0, y: 0, z: 0 },
  exitAxis: '+y',
  clampDepthMm: 10,
  heatPathWPerK: 0.026,
  hotSpotHeatCapacityJPerK: 1.1,
  combination: null,
};
/** TEST-ONLY method specs, parsed so they are valid catalogue data. */
const spec = (fields: Record<string, unknown>) =>
  TerminalMethodSpec.parse({ ...base, drives: fields['torqueNm'] ? ['slotted'] : [], ...fields });
const PLATE = spec({ method: 'screw', clampType: 'pressurePlate', torqueNm: 4, contactOhm: 3e-4 });
const BINDING = spec({ method: 'screw', clampType: 'bindingScrew', torqueNm: 4, contactOhm: 3e-4 });
const PLATE_AL = spec({ method: 'screw', clampType: 'pressurePlate', torqueNm: 4, contactOhm: 3e-4, alRated: true });
const CAGE = spec({
  method: 'springCage',
  clampType: 'springCage',
  torqueNm: null,
  contactOhm: 3e-4,
  stripLengthMm: { nominal: 10, tolerance: 1 },
  clampDepthMm: 9,
});
const BACKSTAB = spec({
  method: 'backStab',
  clampType: 'pushIn',
  torqueNm: null,
  contactOhm: 1e-3,
  stranding: ['solid'],
  awgRange: { smallest: 14, largest: 14 },
  stripLengthMm: { nominal: 16, tolerance: 1 },
  clampDepthMm: 12,
});
const NUT = spec({
  method: 'twistOn',
  clampType: 'twistOn',
  torqueNm: null,
  contactOhm: 5e-4,
  ratedConductors: 3,
  maxConductors: 3,
  awgRange: { smallest: 18, largest: 12 },
  combination: {
    minConductors: 2,
    maxConductors: 3,
    awg: { smallest: 18, largest: 12 },
    totalAreaUm2: { min: 1646094, max: 9926310 },
  },
});

/** A termination outcome: the ideal one for `method`, with `fields` changed. */
function made(method: TerminalMethodSpec, fields: Partial<TerminationV3> = {}): TerminationV3 {
  return { ...autoTermination(1, method), auto: false, ...fields };
}
const end = (s: TerminalMethodSpec, fields: Partial<TerminationV3> = {}, landedCount = 1): ContactEnd => ({
  termination: made(s, fields),
  spec: s,
  landedCount,
});
const ohm = (e: ContactEnd, conductor = COPPER) => {
  const parts = asMadeContact(e, conductor);
  return parts.constrictionOhm + parts.filmOhm;
};
const ferrule = (crimpQuality: number) => ({ ref: { id: 'ferrule.test-14', version: 1 }, crimpQuality });
const close = (actual: number, expected: number, relative = 1e-12) =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.abs(expected) * relative);

describe('the as-made contact model (ADR 0018 §4, F3.3 part 1)', () => {
  it('the constants carry the ADR 0018 §11 values and kinds', () => {
    expect(SEAT_FRACTION).toMatchObject({ value: 0.4, kind: 'game-design' });
    expect(LOOSE_FILM_OHM).toMatchObject({ value: 0.1, unit: 'Ω', kind: 'game-design' });
    expect(STRAND_SPREAD_FACTOR).toMatchObject({ value: 0.5, kind: 'game-design' });
    expect(NICK_MAX_FRACTION).toMatchObject({ value: 0.9, kind: 'game-design' });
    expect(CRIMP_GOOD_OHM).toMatchObject({ value: 5e-5, unit: 'Ω', kind: 'game-design' });
    expect(AL_UNRATED_DEGRADATION_MULTIPLIER).toMatchObject({ value: 10, kind: 'game-design' });
    // 100 % IACS is exactly the materials table's copper resistivity, so copper's metal factor is exactly 1.
    expect(TERMINAL_RESISTIVITY_OHM_M).toMatchObject({ kind: 'real-world' });
    expect(TERMINAL_RESISTIVITY_OHM_M.value).toBe(1.724137931034483e-8);
    expect(metalContactFactor(COPPER.resistivityOhmM)).toBe(1);
  });

  it('golden 1: an ideal screw at its marked torque (and `auto`) is R₀ = 0.300 mΩ, all constriction', () => {
    const parts = asMadeContact(end(PLATE), COPPER);
    expect(parts).toStrictEqual({ constrictionOhm: 3e-4, filmOhm: 0 });
    const auto: ContactEnd = { termination: autoTermination(9, PLATE), spec: PLATE, landedCount: 1 };
    expect(asMadeContact(auto, COPPER)).toStrictEqual(parts);
  });

  it('golden 2: 20 % torque is 0.3/√0.4 + 100 × 0.5² = 25.4743 mΩ (84.9 × R₀), mostly film', () => {
    // r = 0.8 / 4 = 0.2 < r_seat: seated term frozen at 0.3/√0.4 = 0.474342 mΩ; film 100 (1 − 0.5)² = 25 mΩ.
    const parts = asMadeContact(end(PLATE, { torqueNm: 0.8 }), COPPER);
    close(parts.constrictionOhm, 0.474341649025257e-3, 1e-12);
    close(parts.filmOhm, 25e-3, 1e-12);
    close(parts.constrictionOhm + parts.filmOhm, 25.4743416490253e-3, 1e-12);
    close((parts.constrictionOhm + parts.filmOhm) / 3e-4, 84.9145, 5e-6);
  });

  it('ADR 0018 §4.2 table: R_clamp at r = 0 … 1 (mΩ), within 0.5 %', () => {
    const table: [number, number][] = [
      [0, 100.474],
      [0.1, 56.724],
      [0.2, 25.474],
      [0.3, 6.724],
      [0.4, 0.474],
      [0.5, 0.424],
      [1, 0.3],
    ];
    for (const [r, mOhm] of table) {
      close(ohm(end(PLATE, { torqueNm: 4 * r })) * 1e3, mOhm, 0.005);
      close(clampResistanceOhm(3e-4, r) * 1e3, mOhm, 0.005);
    }
  });

  it('golden 3: 25 % nicked strands at full torque is 0.3 × 4/3 = 0.4000 mΩ; nicks are capped at 0.9 (10×)', () => {
    close(ohm(end(PLATE, { nickedStrandFraction: 0.25 })), 0.4e-3, 1e-12);
    close(nickFactor(0.25), 4 / 3, 1e-15);
    expect(nickFactor(0.95)).toBe(nickFactor(0.9));
    close(nickFactor(1), 10, 1e-12);
    expect(nickFactor(0)).toBe(1);
  });

  it('golden 4: a ferrule (0.300 + 0.050 = 0.350 mΩ) against bare stranded under a binding screw (0.3/√0.5 = 0.4243 mΩ)', () => {
    const inFerrule = asMadeContact(end(BINDING, { accessory: ferrule(1) }), COPPER_STRANDED);
    expect(inFerrule.constrictionOhm).toBe(3e-4);
    close(inFerrule.filmOhm, 5e-5, 1e-12); // the good crimp, in the film part
    close(ohm(end(BINDING, { accessory: ferrule(1) }), COPPER_STRANDED), 0.35e-3, 1e-12);
    // Bare: r_eff = 1 × 0.5 = 0.5 ≥ r_seat, so 0.3/√0.5 = 0.424264 mΩ, no film.
    close(ohm(end(BINDING), COPPER_STRANDED), 0.424264068711928e-3, 1e-12);
    close(effectiveClampRatio(end(BINDING), 'stranded'), 0.5, 0);
    // A pressure plate holds bare strands: no spread factor, R₀.
    expect(ohm(end(PLATE), COPPER_STRANDED)).toBe(3e-4);
    // Solid under a binding screw: no spread.
    expect(ohm(end(BINDING), COPPER)).toBe(3e-4);
  });

  it('golden 5: an under-crimped lug (wrong die, q = 0.25): 0.05/√0.4 + 100 × 0.375² = 14.1416 mΩ, plus 0.300', () => {
    close(crimpResistanceOhm(0.25), 14.1415569415042e-3, 1e-12);
    const lug = { ref: { id: 'lug.test-ring-14', version: 1 }, crimpQuality: 0.25 };
    const parts = asMadeContact(end(PLATE, { accessory: lug }), COPPER_STRANDED);
    expect(parts.constrictionOhm).toBe(3e-4); // a lug lands like a solid conductor
    close(parts.constrictionOhm + parts.filmOhm, 14.4415569415042e-3, 1e-12);
    // An open crimp (q = 0) is 0.05/√0.4 + 100 = 100.079 mΩ.
    close(crimpResistanceOhm(0), 100.079056941504e-3, 1e-12);
    expect(crimpResistanceOhm(1)).toBe(5e-5);
  });

  it('golden 6: two conductors under a one-conductor screw at full torque: r_eff = 1/2, 0.4243 mΩ each', () => {
    close(ohm(end(PLATE, {}, 2)), 0.424264068711928e-3, 1e-12);
    // Within the rating there is no factor (the twist-on's three are rated).
    expect(ohm(end(NUT, {}, 3))).toBe(5e-4);
    // The factors multiply by intent: two bare stranded under one binding screw, r_eff = 0.25 ≈ 48 × R₀.
    close(ohm(end(BINDING, {}, 2), COPPER_STRANDED), 14.5368416490253e-3, 1e-12);
  });

  it('golden 7: aluminium on a method not rated for it changes only the degradation rate (× 10)', () => {
    // (2.8264e-8 + 1.7241379e-8) / (2 × 1.7241379e-8) = 1.319656; 0.3 × 1.319656 = 0.395897 mΩ, rated or not.
    close(metalContactFactor(ALUMINIUM.resistivityOhmM), 1.319656, 1e-12);
    close(ohm(end(PLATE), ALUMINIUM), 0.3958968e-3, 1e-9);
    expect(ohm(end(PLATE_AL), ALUMINIUM)).toBe(ohm(end(PLATE), ALUMINIUM));
    expect(degradationRateMultiplier(PLATE, ALUMINIUM)).toBe(10);
    expect(degradationRateMultiplier(PLATE_AL, ALUMINIUM)).toBe(1);
    expect(degradationRateMultiplier(PLATE, COPPER)).toBe(1);
    // The metal factor scales the whole clamp term, film included: 20 % torque on aluminium.
    close(ohm(end(PLATE, { torqueNm: 0.8 }), ALUMINIUM), 25.4743416490253e-3 * 1.319656, 1e-9);
  });

  it('golden 8: a strip at half the clamp depth seats like half torque: 0.4243 mΩ; a long strip changes nothing', () => {
    close(ohm(end(PLATE, { stripLengthMm: 5 })), 0.424264068711928e-3, 1e-12);
    expect(ohm(end(PLATE, { stripLengthMm: 30 }))).toBe(3e-4);
    // 30 % of the depth is in the loose regime: r_eff = 0.3, 6.7243 mΩ.
    close(ohm(end(PLATE, { stripLengthMm: 3 })), 6.72434164902526e-3, 1e-12);
    // With a ferrule or lug the clamp grips the accessory: no strip factor, only the crimp (0.05 mΩ).
    const lug = { ref: { id: 'lug.test-ring-14', version: 1 }, crimpQuality: 1 };
    close(ohm(end(PLATE, { stripLengthMm: 3, accessory: lug })), 0.35e-3, 1e-12);
  });

  it('golden 9: spring cage and back-stab at nominal strip; a twist-on inside its combination', () => {
    // Fixed spring force: r = 1. R₀ = 0.3 mΩ (spring cage), 1.0 mΩ (back-stab), 0.5 mΩ (twist-on).
    expect(torqueRatio(made(CAGE), CAGE)).toBe(1);
    expect(ohm(end(CAGE))).toBe(3e-4);
    expect(ohm(end(CAGE, { accessory: ferrule(1) }), COPPER_STRANDED)).toBeCloseTo(0.35e-3, 15);
    expect(ohm(end(BACKSTAB))).toBe(1e-3);
    expect(ohm(end(NUT), COPPER_STRANDED)).toBe(5e-4);
    expect(ohm(end(NUT, {}, 2))).toBe(5e-4);
    // A short strip in a spring cage still seats worse: 4.5 of 9 mm → r_eff 0.5.
    close(ohm(end(CAGE, { stripLengthMm: 4 })), 3e-4 / Math.sqrt(4 / 9), 1e-12);
  });

  it('a clamp-torque outcome without a torque counts as finger-tight; above the mark is no better', () => {
    expect(torqueRatio(made(PLATE, { torqueNm: null }), PLATE)).toBe(0);
    expect(torqueRatio(made(PLATE, { torqueNm: 0 }), PLATE)).toBe(0);
    expect(torqueRatio(made(PLATE, { torqueNm: 6 }), PLATE)).toBe(1);
    close(ohm(end(PLATE, { torqueNm: null })), 100.474341649025e-3, 1e-12);
  });

  it('asMadeContactInto writes into the given object and returns it (no allocation in the hot path)', () => {
    const out = { constrictionOhm: -1, filmOhm: -1 };
    const e = end(PLATE, { torqueNm: 1.2, nickedStrandFraction: 0.1 });
    expect(asMadeContactInto(out, e, COPPER)).toBe(out);
    expect(out).toStrictEqual(asMadeContact(e, COPPER));
  });

  it('properties: non-increasing in torque up to the mark, flat above, finite at 0, continuous with a slope step at r_seat', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 8, noNaN: true }),
        fc.double({ min: 0, max: 8, noNaN: true }),
        fc.constantFrom(PLATE, BINDING),
        fc.constantFrom(COPPER, COPPER_STRANDED, ALUMINIUM),
        fc.integer({ min: 1, max: 2 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (t1, t2, s, conductor, n, nick) => {
          const [lo, hi] = t1 <= t2 ? [t1, t2] : [t2, t1];
          const r = (t: number) => ohm(end(s, { torqueNm: t, nickedStrandFraction: nick }, n), conductor);
          expect(Number.isFinite(r(lo))).toBe(true);
          expect(r(lo)).toBeGreaterThanOrEqual(r(hi));
          if (hi < 4 && lo < hi) expect(r(lo)).toBeGreaterThan(r(hi) * (1 - 1e-15));
          if (lo >= 4) expect(r(lo)).toBe(r(hi));
        },
      ),
      { numRuns: 300 },
    );
    // Strictly decreasing below the mark: compare on a grid.
    for (let i = 0; i < 100; i++) {
      expect(clampResistanceOhm(3e-4, i / 100)).toBeGreaterThan(clampResistanceOhm(3e-4, (i + 1) / 100));
    }
    // Continuous at r_seat, with the slope step: 0 just below (film C¹, seated frozen), −R₀/(2 r_seat^1.5)
    // = −0.593 mΩ per unit ratio just above.
    const h = 1e-7;
    const at = clampResistanceOhm(3e-4, 0.4);
    expect(Math.abs(clampResistanceOhm(3e-4, 0.4 - h) - at)).toBeLessThan(1e-9);
    expect(Math.abs(clampResistanceOhm(3e-4, 0.4 + h) - at)).toBeLessThan(1e-9);
    const left = (at - clampResistanceOhm(3e-4, 0.4 - h)) / h;
    const right = (clampResistanceOhm(3e-4, 0.4 + h) - at) / h;
    expect(Math.abs(left)).toBeLessThan(1e-7);
    close(right, -3e-4 / (2 * 0.4 * Math.sqrt(0.4)), 1e-4);
  });

  it('properties: a pure function of the outcome, spec, count and conductor; never below R₀ · m', () => {
    fc.assert(
      fc.property(
        fc.record({
          torqueNm: fc.option(fc.double({ min: 0, max: 8, noNaN: true }), { nil: null }),
          stripLengthMm: fc.integer({ min: 0, max: 40 }),
          nickedStrandFraction: fc.double({ min: 0, max: 1, noNaN: true }),
          crimp: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null }),
        }),
        fc.constantFrom(PLATE, BINDING, CAGE, BACKSTAB, NUT),
        fc.constantFrom(COPPER, COPPER_STRANDED, ALUMINIUM),
        fc.integer({ min: 1, max: 3 }),
        ({ torqueNm, stripLengthMm, nickedStrandFraction, crimp }, s, conductor, n) => {
          const e = end(
            s,
            {
              torqueNm: s.torqueNm === null ? null : torqueNm,
              stripLengthMm,
              nickedStrandFraction,
              accessory: crimp === null ? null : ferrule(crimp),
            },
            n,
          );
          const first = asMadeContact(e, conductor);
          expect(asMadeContact(structuredClone(e), { ...conductor })).toStrictEqual(first);
          const total = first.constrictionOhm + first.filmOhm;
          expect(Number.isFinite(total)).toBe(true);
          expect(total).toBeGreaterThanOrEqual(
            s.contactOhm * metalContactFactor(conductor.resistivityOhmM) * (1 - 1e-15),
          );
          expect(first.filmOhm).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('the built-in screw terminals carry ADR 0018 §8 screw-class values', () => {
    const methods = BUILTIN_CATALOG.devices
      .flatMap((d) => d.terminals.flatMap((t) => t.methods))
      .filter((m) => m.method === 'screw');
    // The breaker (2), the DIN supply (2), the stand-in service (3), D12's heater (2) and lamp (2), and
    // F3.5 part 2's screw and ground terminal blocks (2 each).
    expect(methods.length).toBe(15);
    for (const m of methods) {
      expect(m.contactOhm).toBe(3e-4);
      expect(m.heatPathWPerK).toBe(0.026);
      expect(m.combination).toBeNull();
      // Only the 120 V lamp's side-wired holder screws are binding heads (they splay bare strands).
      expect(['pressurePlate', 'boxLug', 'bindingScrew']).toContain(m.clampType);
      expect(m.clampDepthMm).toBeLessThanOrEqual(m.stripLengthMm.nominal - m.stripLengthMm.tolerance);
    }
    expect(methods.filter((m) => m.clampType === 'bindingScrew')).toHaveLength(2);
  });
});

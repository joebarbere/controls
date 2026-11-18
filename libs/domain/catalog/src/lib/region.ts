import type { RegionId } from '@controls/save-format';
import type { RuleSetRef } from './rules';

/*
 * Region profiles (plan §4.10, F2.2 part 2): the electrical facts of a region's supply that the
 * simulator needs: its frequency and the nominal system voltages its utility, panel and source models
 * use (F2.4's utility and three-phase sources, P4's load centre, P6's panelboards). NEC (the United
 * States) is the only region through 1.0; `RegionId` is its save-format id.
 *
 * Every value carries a `source` (realism charter, plan §3), reviewed by `electrical-realism-reviewer`.
 * The voltages are **nominal** system voltages, the names systems go by, not what a meter reads: a
 * utility delivers a band around them. In a nominal system designation both members of each pair are
 * rounded: 208Y/120 names 120 × √3 = 207.85 V, and 480Y/277 names 480 / √3 = 277.13 V (or 277 × √3 =
 * 479.78 V). Equipment nameplates carry utilization ratings instead (200, 230, 460 V), which are not
 * these. A source model takes the **line-to-neutral value as the exact magnitude** and builds its phases
 * with the exact ±120° angles, so its line-to-line voltage is the exact √3 multiple, never the rounded
 * name.
 */

/** A sourced numeric fact of a region. */
export interface RegionValue {
  readonly value: number;
  /** SI unit symbol. */
  readonly unit: string;
  readonly kind: 'real-world' | 'game-design';
  readonly source: string;
}

/** A nominal system: its line-to-neutral and line-to-line voltages (RMS). */
export interface NominalSystem {
  /** How the system is named, e.g. `120/240 V` or `208Y/120 V`. */
  readonly name: string;
  readonly phases: 1 | 3;
  readonly lineToNeutralV: RegionValue;
  readonly lineToLineV: RegionValue;
}

/** A band of steady-state voltage, as fractions of the nominal system voltage (unit `1`). */
export interface VoltageRange {
  readonly min: RegionValue;
  readonly max: RegionValue;
}

/**
 * A region's supply-voltage tolerance bands (F2.4): what a utility delivers at the **service** point
 * (the meter) and what equipment sees at its **utilization** point (after the building's wiring drop),
 * in the normal range A and the occasional range B. As fractions of nominal, so they apply to every
 * nominal system of the region (120 V, 240 V, 208 V, 480 V, …) at the low-voltage level.
 */
export interface VoltageRanges {
  /** Range A at the service point: the voltage a utility should hold in normal operation. */
  readonly serviceA: VoltageRange;
  /** Range A at the utilization point: what equipment must operate satisfactorily within. */
  readonly utilizationA: VoltageRange;
  /** Range B at the service point: outside range A, infrequent and limited in time, corrected soon. */
  readonly serviceB: VoltageRange;
  /** Range B at the utilization point. */
  readonly utilizationB: VoltageRange;
}

/**
 * A colour a rule accepts (catalogue v2): a base insulation colour, or any base the rule doesn't
 * exclude (`base: null`), with a tracer stripe or none. Colour ids are rows of the catalogue colour
 * table. The world stores one stripe per conductor, so "three continuous stripes" is one stripe here.
 */
export interface ColourPattern {
  readonly base: string | null;
  readonly stripe: string | null;
}

/** Whether a rule is the region's code or industry convention (labelled honestly, realism charter). */
export type ColourRuleBasis = 'code' | 'convention';

/** A region's identification rule for one conductor role, over colour ids. */
export interface ConductorColourRule {
  readonly patterns: readonly ColourPattern[];
  /** Bases a `base: null` pattern doesn't accept. */
  readonly excludedBases: readonly string[];
  readonly basis: ColourRuleBasis;
  readonly kind: 'real-world' | 'game-design';
  readonly source: string;
}

/** The colours conventionally used for a nominal system's ungrounded conductors, in line order (L1, L2, L3). */
export interface UngroundedColourConvention {
  /** A nominal system's `name` in this profile. */
  readonly system: string;
  readonly colours: readonly string[];
  readonly basis: ColourRuleBasis;
  readonly kind: 'real-world' | 'game-design';
  readonly source: string;
}

/**
 * A region's conductor colour rules (catalogue v2, ADR 0015): the rules P4's inspector checks against.
 * They are never part of the load check, and they say nothing about which colours a product is made
 * in (that is each conductor entry's `colours`). Article numbers are cited and paraphrased; no code
 * text is reproduced.
 */
export interface RegionConductorColours {
  /** How a grounded (neutral) conductor is identified. */
  readonly grounded: ConductorColourRule;
  /** How an equipment grounding conductor is identified. */
  readonly equipmentGrounding: ConductorColourRule;
  /** Bases an ungrounded conductor may not have (reserved for the grounded conductor and the EGC). */
  readonly notForUngrounded: {
    readonly colours: readonly string[];
    readonly basis: ColourRuleBasis;
    readonly source: string;
  };
  /** Ungrounded colours by nominal system: convention, not code. */
  readonly ungrounded: readonly UngroundedColourConvention[];
  /** The marking of a delta system's high leg. */
  readonly highLeg: { readonly colour: string; readonly basis: ColourRuleBasis; readonly source: string };
}

/** Whether `colour` matches one of `rule`'s patterns. */
export function matchesColourRule(rule: ConductorColourRule, colour: { base: string; stripe: string | null }): boolean {
  return rule.patterns.some(
    (p) =>
      (p.base === null ? !rule.excludedBases.includes(colour.base) : p.base === colour.base) &&
      p.stripe === colour.stripe,
  );
}

/** One point of a sourced limit curve: at `x` (in `xUnit`), at most `y` (in `yUnit`). */
export interface CurvePoint {
  readonly x: number;
  readonly y: number;
}

/** A sourced limit curve (catalogue v3): points in ascending `x`, read between them by the model that uses it. */
export interface RegionCurve {
  readonly xUnit: string;
  readonly yUnit: string;
  readonly points: readonly CurvePoint[];
  readonly kind: 'real-world' | 'game-design';
  readonly source: string;
}

/**
 * The ground-fault protection class a region's GFCI devices meet (catalogue v3, D7): the band its
 * pickup must sit in and the inverse-time limit its trip must beat. A GFCI entry's own drawn band
 * (pickup, mechanism time) sits inside these; the limit is an upper limit only.
 */
export interface GfciClassLimits {
  /** The class name (`A`: the US personnel-protection class). */
  readonly className: string;
  /** Below this residual current it must not trip (A). */
  readonly pickupMinA: RegionValue;
  /** At and above this residual current it must trip (A). */
  readonly pickupMaxA: RegionValue;
  /**
   * The longest it may take to trip at a residual current (x in A, y in s), tabulated at the pre-audit's
   * points; D7's model reads it as a rate (1/t), interpolated linearly in rate.
   */
  readonly tripTimeLimit: RegionCurve;
}

/**
 * The arc-fault protection a region's AFCI devices meet (catalogue v3, D8): series arcing at or above
 * `minArcCurrentA` is cleared within `maxTripAtMinS`, and at `ratedMultiple` × the device's rating
 * within `maxTripAtRatedMultipleS`; nothing is required below `minArcCurrentA`.
 */
export interface AfciLimits {
  readonly minArcCurrentA: RegionValue;
  readonly maxTripAtMinS: RegionValue;
  readonly ratedMultiple: RegionValue;
  readonly maxTripAtRatedMultipleS: RegionValue;
}

/** A region's protective-device limits (catalogue v3). */
export interface RegionProtection {
  readonly gfci: GfciClassLimits;
  readonly afci: AfciLimits;
}

/** One region's electrical profile. */
export interface RegionProfile {
  readonly id: RegionId;
  readonly title: string;
  /** The supply frequency: the AC solver's (F2.2 part 2) analysis frequency. */
  readonly frequencyHz: RegionValue;
  /** Single-phase three-wire (split-phase): two lines 180° apart about a grounded neutral. */
  readonly splitPhase: NominalSystem;
  /** Three-phase four-wire wye, the commercial service. */
  readonly threePhaseCommercial: NominalSystem;
  /** Three-phase four-wire wye, the industrial service. */
  readonly threePhaseIndustrial: NominalSystem;
  /** Steady-state voltage ranges (F2.4): service and utilization, ranges A and B. */
  readonly voltageRanges: VoltageRanges;
  /** Conductor identification rules over colour ids (catalogue v2): code and convention, labelled. */
  readonly conductorColours: RegionConductorColours;
  /** GFCI and AFCI limits (catalogue v3, D7, D8). */
  readonly protection: RegionProtection;
  /** The inspector rule set the region checks against (catalogue v3, D13): must resolve in the catalogue. */
  readonly inspectorRules: RuleSetRef;
}

/** `range` at `nominalV`: the band in volts, `[min, max]`. */
export function voltageBand(range: VoltageRange, nominalV: number): readonly [number, number] {
  return [range.min.value * nominalV, range.max.value * nominalV];
}

const ANSI_C84_1 =
  'ANSI C84.1-2020, "American National Standard for Electric Power Systems and Equipment — Voltage Ratings (60 Hertz)", which lists the standard nominal system voltages of US utility services';
const IEEE_141 =
  'IEEE Std 141-1993 ("Red Book", Recommended Practice for Electric Power Distribution for Industrial Plants), ch. 3, "Voltage considerations", on the nominal voltages of US low-voltage systems (withdrawn; superseded by the IEEE 3000 series, IEEE Std 3001.x and 3002.x)';

/**
 * The code edition the colour rules cite. Pinned to 2023: the 2026 edition's numbering wasn't checked
 * (P3 source pre-audit).
 */
const NFPA_70 = 'NFPA 70-2023 (National Electrical Code)';

const volts = (value: number, source: string): RegionValue => ({ value, unit: 'V', kind: 'real-world', source });

/**
 * ANSI C84.1's voltage ranges, as facts on a 120 V base (paraphrased; the standard's table is not
 * reproduced). The standard defines two ranges for each nominal system: **Range A**, the band service
 * voltage is held to in normal operation and equipment is designed to work well in, and **Range B**,
 * wider, for conditions that should be infrequent, limited in time and corrected. Each has a service
 * (point of delivery) and a utilization (point of use) band; utilization's lower limits allow for the
 * voltage drop of the premises wiring. On a 120 V base the boundaries are: Range A service 114–126 V,
 * utilization 108–125 V; Range B service 110–127 V, utilization 104–127 V. Here as fractions of
 * nominal; the standard tabulates each low-voltage system in rounded volts, which these fractions agree
 * with within that rounding (208 V: 197.6 and 216.7 V against the table's 197 and 216). Notes taken:
 * Range A's utilization maximum of 125 V is the standard's note lowering 126 V for 120–600 V systems;
 * the utilization minimums are the general column (108 V and 104 V), not the slightly higher values
 * published copies show in parentheses (110 V and 106 V), which appear to apply to circuits that also
 * supply lighting. The 2020 text itself was not available to the realism review: no clause number is
 * cited until someone checks it.
 */
const C84_1_RANGES =
  "ANSI C84.1-2020, Electric Power Systems and Equipment, Voltage Ratings (60 Hz): Range A and Range B service and utilization limits for 120–600 V nominal systems, as given for the 120 V system in its table of nominal system voltages and voltage ranges (with its note limiting Range A utilization to 125 V) and scaled to the other low-voltage systems, which the table's rounded values follow; paraphrased as fractions of nominal (Range A service ±5 %, utilization −10 %/+4.2 %; Range B service −8.3 %/+5.8 %, utilization −13.3 %/+5.8 %); corroborated by published utility service-voltage rules (Pacific Power and PG&E voltage-tolerance documents). Utilization minimums from the general column, not the parenthesised values (which appear to apply to circuits that also supply lighting). Table not reproduced";
const fraction = (volts120: number, what: string): RegionValue => ({
  value: volts120 / 120,
  unit: '1',
  kind: 'real-world',
  source: `${what}: ${volts120} V on a 120 V base, as a fraction of nominal. ${C84_1_RANGES}.`,
});

/**
 * UL 943's Class A limits (catalogue v3, D7), cited by number and paraphrased, never quoted. The
 * inverse-time limit is the published power law t = (20 mA / I)^1.43 s for residual currents from 6 to
 * 264 mA (a GFCI maker's public FAQ and an industry research report on appliance leakage, both read
 * 2026-11-17; maker not named in content), tabulated here offline at the P4 pre-audit's points, so no
 * fractional power runs in the game (D6); `region.spec.ts` recomputes every point within 0.5 %.
 */
const UL_943_CLASS_A =
  'UL 943 (cited by number, paraphrased): a US Class A ground-fault circuit interrupter for personnel protection trips when the residual (ground-fault) current reaches 6 mA and does not trip below 4 mA; above that its trip time is limited by an inverse-time curve published in makers’ application notes and FAQs as t = (20 mA / I)^1.43 seconds for 6 to 264 mA (read 2026-11-17). Faster is allowed: the curve is an upper limit only. Vetted by the P4 source pre-audit (electrical-realism-reviewer, 2026-11-17)';

/** The Class A trip-time limit at the pre-audit's points (mA → s), from t = (20 / I)^1.43 computed offline. */
const GFCI_LIMIT_POINTS_MA_S: readonly (readonly [number, number])[] = [
  [6, 5.594],
  [10, 2.695],
  [20, 1.0],
  [30, 0.56],
  [50, 0.2697],
  [100, 0.1001],
  [150, 0.0561],
  [264, 0.025],
];

const UL_1699 =
  'UL 1699 (cited by number, paraphrased): a combination-type arc-fault circuit interrupter must clear series arcing (the carbonized-path clearing-time test) within 1 s at a 5 A arc current and in less than 0.2 s at 1.5 times its rating (the 22.5 or 30 A test level of a 15 or 20 A device); nothing is required below 5 A. From the P4 source pre-audit (electrical-realism-reviewer, 2026-11-17), corroborated by public descriptions of the test levels (5 A; 10 A; 15 or 20 A; 22.5 or 30 A) and the 1 s limit at 5 A (patent filings and an inspectors’ association article, read 2026-11-17). The standard’s table itself is not reproduced';

const regionValue = (value: number, unit: string, source: string): RegionValue => ({
  value,
  unit,
  kind: 'real-world',
  source,
});

/** The NEC region: the United States' 60 Hz supply and its usual low-voltage systems. */
export const NEC_REGION: RegionProfile = Object.freeze<RegionProfile>({
  id: 'nec',
  title: 'United States (NEC)',
  frequencyHz: {
    value: 60,
    unit: 'Hz',
    kind: 'real-world',
    source: `The nominal frequency of the North American interconnections (Eastern, Western, ERCOT and Québec), 60 Hz; the frequency in the title of ${ANSI_C84_1}.`,
  },
  splitPhase: {
    name: '120/240 V',
    phases: 1,
    lineToNeutralV: volts(
      120,
      `Single-phase three-wire 120/240 V, the usual US residential service: 120 V from each line to the neutral (the transformer secondary's centre tap). ${ANSI_C84_1}; ${IEEE_141}.`,
    ),
    lineToLineV: volts(
      240,
      `The same 120/240 V service across its two lines, which are 180° apart: 2 × 120 V. ${ANSI_C84_1}.`,
    ),
  },
  threePhaseCommercial: {
    name: '208Y/120 V',
    phases: 3,
    lineToNeutralV: volts(
      120,
      `Three-phase four-wire wye 208Y/120 V, the usual US commercial service: 120 V from each phase to the neutral. ${ANSI_C84_1}; ${IEEE_141}.`,
    ),
    lineToLineV: volts(
      208,
      `The same 208Y/120 V system between phases, which are 120° apart: the nominal designation of 120 × √3 = 207.85 V. ${ANSI_C84_1}.`,
    ),
  },
  threePhaseIndustrial: {
    name: '480Y/277 V',
    phases: 3,
    lineToNeutralV: volts(
      277,
      `Three-phase four-wire wye 480Y/277 V, the usual US industrial and large commercial service: 277 V from each phase to the neutral (lighting circuits). ${ANSI_C84_1}; ${IEEE_141}.`,
    ),
    lineToLineV: volts(
      480,
      `The same 480Y/277 V system between phases: the nominal designation of 277 × √3 = 479.78 V; both members are rounded, since 480 / √3 = 277.13 V. ${ANSI_C84_1}.`,
    ),
  },
  voltageRanges: {
    serviceA: { min: fraction(114, 'Range A service minimum'), max: fraction(126, 'Range A service maximum') },
    utilizationA: {
      min: fraction(108, 'Range A utilization minimum (the general column)'),
      max: fraction(125, "Range A utilization maximum (the standard's 125 V note for 120–600 V systems)"),
    },
    serviceB: { min: fraction(110, 'Range B service minimum'), max: fraction(127, 'Range B service maximum') },
    utilizationB: {
      min: fraction(104, 'Range B utilization minimum (the general column)'),
      max: fraction(127, 'Range B utilization maximum'),
    },
  },
  conductorColours: {
    grounded: {
      patterns: [
        { base: 'white', stripe: null },
        { base: 'grey', stripe: null },
        { base: null, stripe: 'white' },
        { base: null, stripe: 'grey' },
      ],
      excludedBases: ['green'],
      basis: 'code',
      kind: 'real-world',
      source: `${NFPA_70}, Art. 200.6 (cited by number, paraphrased): an insulated grounded conductor of 6 AWG or smaller is identified by a continuous white or grey outer finish, or by continuous white or grey stripes along its whole length on insulation of any colour but green; larger ones may instead be identified where they terminate. The world stores one stripe, so the code's three stripes are one stripe id here.`,
    },
    equipmentGrounding: {
      patterns: [
        { base: 'bare', stripe: null },
        { base: 'green', stripe: null },
        { base: 'green', stripe: 'yellow' },
      ],
      excludedBases: [],
      basis: 'code',
      kind: 'real-world',
      source: `${NFPA_70}, Art. 250.119 (cited by number, paraphrased): an equipment grounding conductor may be bare; if covered or insulated, its outer finish is continuous green, or green with one or more yellow stripes. Conductors larger than 6 AWG may be re-identified where they terminate.`,
    },
    notForUngrounded: {
      colours: ['white', 'grey', 'green'],
      basis: 'code',
      source: `${NFPA_70}, Art. 200.7 (white and grey finishes are kept for the grounded conductor, with narrow exceptions for re-identified conductors) and Art. 250.119 (green finishes are kept for equipment grounding), cited by number and paraphrased.`,
    },
    ungrounded: [
      {
        system: '120/240 V',
        colours: ['black', 'red'],
        basis: 'convention',
        kind: 'real-world',
        source: `Industry convention, not a code rule: black and red for the two lines of a 120/240 V single-phase service. ${NFPA_70}, Arts. 210.5(C) and 215.12(C) (cited by number) require the identification method of ungrounded conductors to be documented where more than one nominal system is present, without mandating colours.`,
      },
      {
        system: '208Y/120 V',
        colours: ['black', 'red', 'blue'],
        basis: 'convention',
        kind: 'real-world',
        source: `Industry convention, not a code rule: black, red and blue for L1, L2 and L3 of a 208Y/120 V system. ${NFPA_70}, Arts. 210.5(C) and 215.12(C) (cited by number) require the method to be documented where more than one nominal system is present, without mandating colours.`,
      },
      {
        system: '480Y/277 V',
        colours: ['brown', 'orange', 'yellow'],
        basis: 'convention',
        kind: 'real-world',
        source: `Industry convention, not a code rule: brown, orange and yellow for L1, L2 and L3 of a 480Y/277 V system. ${NFPA_70}, Arts. 210.5(C) and 215.12(C) (cited by number) require the method to be documented where more than one nominal system is present, without mandating colours.`,
      },
    ],
    highLeg: {
      colour: 'orange',
      basis: 'code',
      source: `${NFPA_70}, Art. 110.15 (cited by number, paraphrased): on a four-wire delta system with one phase leg at the higher voltage to ground, that leg is durably marked orange or by another effective means. No P3 source builds such a system.`,
    },
  },
  protection: {
    gfci: {
      className: 'A',
      pickupMinA: regionValue(0.004, 'A', `${UL_943_CLASS_A}: the 4 mA no-trip limit.`),
      pickupMaxA: regionValue(0.006, 'A', `${UL_943_CLASS_A}: the 6 mA must-trip limit.`),
      tripTimeLimit: {
        xUnit: 'A',
        yUnit: 's',
        points: GFCI_LIMIT_POINTS_MA_S.map(([mA, s]) => ({ x: mA / 1000, y: s })),
        kind: 'real-world',
        source: `${UL_943_CLASS_A}: the limit at 6, 10, 20, 30, 50, 100, 150 and 264 mA, rounded to four significant figures (the pre-audit's values; each within 0.15 % of the curve).`,
      },
    },
    afci: {
      minArcCurrentA: regionValue(5, 'A', `${UL_1699}: the 5 A arc current below which nothing is required.`),
      maxTripAtMinS: regionValue(1, 's', `${UL_1699}: 1 s at 5 A.`),
      ratedMultiple: regionValue(1.5, '1', `${UL_1699}: the 1.5 × rating test level.`),
      maxTripAtRatedMultipleS: regionValue(0.2, 's', `${UL_1699}: under 0.2 s at 1.5 × rating.`),
    },
  },
  inspectorRules: { ruleSet: 'nec', version: 1 },
});

/** Every region's profile, by `RegionId`. */
export const REGION_PROFILES: Readonly<Record<RegionId, RegionProfile>> = Object.freeze({ nec: NEC_REGION });

/** The profile of `region`. */
export function regionProfile(region: RegionId): RegionProfile {
  return REGION_PROFILES[region];
}

import type { RegionId } from '@controls/save-format';

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
}

/** `range` at `nominalV`: the band in volts, `[min, max]`. */
export function voltageBand(range: VoltageRange, nominalV: number): readonly [number, number] {
  return [range.min.value * nominalV, range.max.value * nominalV];
}

const ANSI_C84_1 =
  'ANSI C84.1-2020, "American National Standard for Electric Power Systems and Equipment — Voltage Ratings (60 Hertz)", which lists the standard nominal system voltages of US utility services';
const IEEE_141 =
  'IEEE Std 141-1993 ("Red Book", Recommended Practice for Electric Power Distribution for Industrial Plants), ch. 3, "Voltage considerations", on the nominal voltages of US low-voltage systems (withdrawn; superseded by the IEEE 3000 series, IEEE Std 3001.x and 3002.x)';

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
  "ANSI C84.1-2020, Electric Power Systems and Equipment, Voltage Ratings (60 Hz): Range A and Range B service and utilization limits for 120–600 V nominal systems, as given for the 120 V system in its table of nominal system voltages and voltage ranges (with its note limiting Range A utilization to 125 V) and scaled to the other low-voltage systems, which the table's rounded values follow; paraphrased as fractions of nominal (Range A service ±5 %, utilization −10 %/+4.2 %; Range B service −8.3 %/+5.8 %, utilization −13.3 %/+5.8 %); corroborated by published utility service-voltage rules (Pacific Power and PG&E voltage-tolerance documents). Utilization minimums from the general column, not the parenthesised lighting values. Table not reproduced";
const fraction = (volts120: number, what: string): RegionValue => ({
  value: volts120 / 120,
  unit: '1',
  kind: 'real-world',
  source: `${what}: ${volts120} V on a 120 V base, as a fraction of nominal. ${C84_1_RANGES}.`,
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
});

/** Every region's profile, by `RegionId`. */
export const REGION_PROFILES: Readonly<Record<RegionId, RegionProfile>> = Object.freeze({ nec: NEC_REGION });

/** The profile of `region`. */
export function regionProfile(region: RegionId): RegionProfile {
  return REGION_PROFILES[region];
}

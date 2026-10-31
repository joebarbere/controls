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
}

const ANSI_C84_1 =
  'ANSI C84.1-2020, "American National Standard for Electric Power Systems and Equipment — Voltage Ratings (60 Hertz)", which lists the standard nominal system voltages of US utility services';
const IEEE_141 =
  'IEEE Std 141-1993 ("Red Book", Recommended Practice for Electric Power Distribution for Industrial Plants), ch. 3, "Voltage considerations", on the nominal voltages of US low-voltage systems (withdrawn; superseded by the IEEE 3000 series, IEEE Std 3001.x and 3002.x)';

const volts = (value: number, source: string): RegionValue => ({ value, unit: 'V', kind: 'real-world', source });

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
});

/** Every region's profile, by `RegionId`. */
export const REGION_PROFILES: Readonly<Record<RegionId, RegionProfile>> = Object.freeze({ nec: NEC_REGION });

/** The profile of `region`. */
export function regionProfile(region: RegionId): RegionProfile {
  return REGION_PROFILES[region];
}

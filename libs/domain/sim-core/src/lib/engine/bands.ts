import type { RegionProfile } from '@controls/catalog';
import { NOMINAL_BAND_NONE, NOMINAL_BANDS } from '@controls/sim-protocol';
import type { SourcedConstant } from '../constants';
import type { Netlist, NetlistBranch } from '../netlist/types';

/*
 * Nominal band selection (plan F2.6, ADR 0011 §5.3, protocol 5): which fixed voltage scale an island's
 * overlay uses, chosen by the engine from its sources' nameplates so readers compute nothing. The
 * band is derived data: it is written into the snapshot's island entry (hashed) and printed by
 * `netlist.dump`, but never persisted (not in `WorldV2.sim`), so it moves no world hash.
 *
 * **The rule** (deterministic: a pure function of the netlist, the catalogue and the region):
 *
 * 1. Each source branch (`branch.source !== null`) gets its device's band from
 *    {@link SOURCE_BAND_RULES} by catalogue model kind and nameplate params. A kind without a rule,
 *    or a nameplate that matches no band, is `none` (an unrated source).
 * 2. An island takes the band all its source branches agree on. With no source it is `none`
 *    (`no-source`); if they all say `none`, `unrated-source`; if they disagree (a 12 V battery
 *    beside a 24 V supply, or beside the bench supply), `none` with `sources-disagree`; a `mixed`
 *    island (DC and AC sources, no converter in P2) is always `none` (`mixed`).
 *
 * Band 0 means "no scale", never the first bin of one (#52 review): the overlays draw no colour.
 */

/** Why an island's band is `none`. */
export type NominalBandReason = 'no-source' | 'unrated-source' | 'sources-disagree' | 'mixed';

/** One island's band and, for `none`, why. */
export interface IslandBand {
  /** An index into `NOMINAL_BANDS`. */
  readonly band: number;
  /** Why it is `none`; `null` for a band with a scale. */
  readonly reason: NominalBandReason | null;
}

const bandIndex = (name: string): number => {
  const index = NOMINAL_BANDS.indexOf(name);
  if (index < 0) throw new Error(`NOMINAL_BANDS has no band ${name}`);
  return index;
};

/** The DC bands' nominal system voltages, matched exactly against a DC source's nameplate. */
export const DC_BAND_NOMINALS: Readonly<Record<'dc12' | 'dc24', SourcedConstant>> = Object.freeze({
  dc12: {
    value: 12,
    unit: 'V',
    kind: 'real-world',
    source:
      'The 12 V nominal DC system: a six-cell lead-acid battery (2 V per cell nominal), the common alarm, UPS and automotive battery voltage; the battery catalogue entry’s `nominalVoltageV` (the 12 V 7 Ah VRLA class, paraphrased from manufacturers’ datasheets).',
  },
  dc24: {
    value: 24,
    unit: 'V',
    kind: 'real-world',
    source:
      'The 24 V nominal DC system: the usual control-circuit voltage of industrial control panels and the rated output of the common DIN-rail switch-mode supply class (the DIN PSU catalogue entry’s `ratedVoltageV`, paraphrased from manufacturers’ datasheets).',
  },
});

/** A source kind's band from its nameplate params and the region: an index into `NOMINAL_BANDS`. */
export type SourceBandRule = (params: Readonly<Record<string, unknown>>, region: RegionProfile) => number;

const dcBand = (volts: unknown): number => {
  for (const name of ['dc12', 'dc24'] as const) if (volts === DC_BAND_NOMINALS[name].value) return bandIndex(name);
  return NOMINAL_BAND_NONE;
};

/** A split-phase source: the region's 120/240 V system when its line-to-neutral voltage is the region's. */
const splitPhaseBand: SourceBandRule = (params, region) =>
  params['lineToNeutralV'] === region.splitPhase.lineToNeutralV.value ? bandIndex('ac120-240') : NOMINAL_BAND_NONE;

/**
 * The band rule of each source model kind (by catalogue model kind). The AC bands are the region
 * profile's nominal systems (`RegionProfile`, sourced to ANSI C84.1 there), matched exactly on the
 * line-to-neutral voltage the source model builds its phases from.
 */
export const SOURCE_BAND_RULES: Readonly<Record<string, SourceBandRule>> = Object.freeze({
  battery: (params) => dcBand(params['nominalVoltageV']),
  'supply.dinPsu': (params) => dcBand(params['ratedVoltageV']),
  // Adjustable from 0 to its maximum: no fixed nominal, so no scale (a game-design choice; the
  // overlay can't know the setpoint class without guessing).
  'supply.bench': () => NOMINAL_BAND_NONE,
  'utility.splitPhase': splitPhaseBand,
  // The stub's nameplate is 120/240 V split-phase (`GENERATOR_STUB_NAMEPLATE`).
  'generator.portable': splitPhaseBand,
  'utility.threePhase': (params, region) => {
    const volts = params['lineToNeutralV'];
    if (volts === region.threePhaseCommercial.lineToNeutralV.value) return bandIndex('ac208y120');
    if (volts === region.threePhaseIndustrial.lineToNeutralV.value) return bandIndex('ac480y277');
    return NOMINAL_BAND_NONE;
  },
});

/**
 * Every island's band (see the file comment). `sourceBand(branch)` gives a source branch's band;
 * it is called only for source branches, in branch order.
 */
export function islandNominalBands(netlist: Netlist, sourceBand: (branch: NetlistBranch) => number): IslandBand[] {
  return netlist.islands.map((island): IslandBand => {
    if (island.kind === 'mixed') return { band: NOMINAL_BAND_NONE, reason: 'mixed' };
    let band = -1;
    for (const index of island.branches) {
      const branch = netlist.branches[index];
      if (branch.source === null) continue;
      const own = sourceBand(branch);
      if (band === -1) band = own;
      else if (own !== band) return { band: NOMINAL_BAND_NONE, reason: 'sources-disagree' };
    }
    if (band === -1) return { band: NOMINAL_BAND_NONE, reason: 'no-source' };
    if (band === NOMINAL_BAND_NONE) return { band, reason: 'unrated-source' };
    return { band, reason: null };
  });
}

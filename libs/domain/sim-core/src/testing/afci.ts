import { LEAD_SIM_BAG_V3, World } from '@controls/save-format';
import { AMBIENT_TEMPERATURE_K } from '../lib/constants';
import { compileNetlist } from '../lib/netlist/compile';
import { engineBus, engineTestOptions, ENGINE_TEST_CATALOG, RHEOSTAT } from './engine';
import { AFCI_15 } from './plug-on';
import { SourceHost, UTILITY_SPLIT } from './sources';
import { LEAD_REF, NUT_REF, THHN_14 } from './wired-loop';

/*
 * The AFCI circuit of `afci.spec.ts` (P4 PR 10), shared with the protocol 8 event-schema spec: the
 * utility stand-in (1); the 15 A AFCI (2) fed L1 → line, its pigtail to N; its load through a THHN
 * conductor between two wire nuts (3, 4) and a 12 Ω rheostat (5) back to its load neutral (the
 * `upstream` variant puts the conductor between L1 and the AFCI's line instead). The conductor's end A
 * starts at degradation `d`; hot spots are held at ambient so its regime is fixed. Specs only.
 */

/** AfciWhere the arcing conductor sits: on the AFCI's load side, or between L1 and its line. */
export type AfciWhere = 'downstream' | 'upstream';
const termination = (id: number) => ({
  id,
  method: 'twistOn',
  auto: false,
  stripLengthMm: 13,
  nickedStrandFraction: 0,
  torqueNm: null,
  accessory: null,
});

/** The circuit above with the conductor's end A at degradation `d`, at `ohms`. */
export function afciWorld(where: AfciWhere, d: number, seed: number, ohms = 12): World {
  const entity = (id: number, ref: { id: string; version: number }, state: Record<string, unknown> = {}) => ({
    id,
    ref,
    transform: { positionMm: { x: 0, y: 0, z: 0 }, orientationMdeg: { yaw: 0, pitch: 0, roll: 0 } },
    state,
    sim: {},
    mountedOn: null,
    inEntry: null,
    pluggedInto: null,
    label: null,
    extensions: {},
  });
  const base = { cable: null, label: null, state: {}, extensions: {}, marking: { a: null, b: null } };
  const lead = (id: number, a: [number, string], b: [number, string]) => ({
    ...base,
    sim: { ...LEAD_SIM_BAG_V3 },
    id,
    ref: LEAD_REF,
    a: { entity: a[0], terminal: a[1], termination: null },
    b: { entity: b[0], terminal: b[1], termination: null },
    route: null,
    lengthMm: null,
    colour: null,
  });
  const conductor = (id: number, from: number, to: number) => ({
    ...base,
    sim: { ...LEAD_SIM_BAG_V3, fused: false, endADegradation: d, endATerminationId: 1, endBTerminationId: 2 },
    id,
    ref: THHN_14,
    a: { entity: from, terminal: 'splice', termination: termination(1) },
    b: { entity: to, terminal: 'splice', termination: termination(2) },
    route: [{ kind: 'free', positionMm: { x: 0, y: 300, z: 0 }, entity: null, fixture: null, tool: null }],
    lengthMm: 1500,
    colour: { base: 'black', stripe: null },
  });
  const connections =
    where === 'downstream'
      ? [
          lead(1, [1, 'l1'], [2, 'line']),
          lead(2, [2, 'pigtail'], [1, 'n']),
          lead(3, [2, 'load'], [3, 'splice']),
          conductor(4, 3, 4),
          lead(5, [4, 'splice'], [5, 'a']),
          lead(6, [5, 'b'], [2, 'loadNeutral']),
        ]
      : [
          lead(1, [1, 'l1'], [3, 'splice']),
          conductor(2, 3, 4),
          lead(3, [4, 'splice'], [2, 'line']),
          lead(4, [2, 'pigtail'], [1, 'n']),
          lead(5, [2, 'load'], [5, 'a']),
          lead(6, [5, 'b'], [2, 'loadNeutral']),
        ];
  return World.parse({
    schemaVersion: 4,
    seed,
    tick: 0,
    nextEntityId: 6,
    nextConnectionId: 7,
    nextCableId: 1,
    nextTerminationId: 3,
    regionId: 'nec',
    difficulty: 'apprentice',
    assisted: false,
    fixtures: [],
    areas: [],
    entities: [
      entity(1, UTILITY_SPLIT),
      entity(2, AFCI_15, { on: true, test: 0 }),
      entity(3, NUT_REF),
      entity(4, NUT_REF),
      entity(5, RHEOSTAT, { ohms }),
    ],
    connections,
    cables: [],
    sim: null,
    extensions: {},
  });
}

/** The conductor's end A as made (Ω), from a compile of the undegraded world. */
export const afciMadeOhm = (where: AfciWhere) => {
  const netlist = compileNetlist(afciWorld(where, 1, 1), ENGINE_TEST_CATALOG);
  const branch = netlist.branches.find((b) => b.element.kind === 'connection' && b.model === 'conductor');
  return branch?.values['endAContactOhm'] as number;
};

/** The engine options of the AFCI circuit: the test models, hot spots held at ambient. */
export const afciOptions = () => ({
  ...engineTestOptions(),
  connectionBank: { holdEndTempK: AMBIENT_TEMPERATURE_K.value },
});
/** A host on the circuit with end A at R_deg = `ohm` (0.4 Ω: intermittent; 0.12 Ω: glowing, never arcing). */
export const afciHost = (where: AfciWhere, ohm: number, seed: number, ohms = 12) =>
  new SourceHost(engineBus(seed, afciWorld(where, ohm / afciMadeOhm(where), seed, ohms)), afciOptions());

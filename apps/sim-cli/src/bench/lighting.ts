import { BUILTIN_CATALOG, type Catalog, catalogOrThrow } from '@controls/catalog';
import type { CommandBus } from '@controls/commands';
import { createWorld, type World } from '@controls/save-format';
import { SimEngine } from '@controls/sim-core';
import { createWorldBus, createWorldRegistry } from '@controls/world-model';
import type { BenchCalibration, BenchCase } from './bench';

/*
 * P4 PR 12's bench cases (review E3): a residential lighting plant on one split-phase service, so one
 * AC island holding every circuit, the phasor outer loop (`acIterate`) in every solve.
 *
 * - 30 circuits, alternating legs, each a dimmer at 0.5 into a 60 W A19 bulb in a keyless lampholder,
 *   an LED A19 bulb in a second holder, and an undimmed 60 W bulb in a third, every link a 1 m test lead.
 * - `lighting-resolve-topology-change`: one dimmer switched off, a structural recompile and the
 *   re-solve with every other dimmer fitting and every driver settling. Calibrated against spec §4.5's
 *   2 ms re-solve after a topology change, as `plant-resolve-topology-change` is.
 * - `lighting-level-change`: one dimmer's slider moved (a value-only recompile and the re-solve).
 *   Reported (`budgetMs: null`): the spec sets no budget for a value change.
 *
 * The lighting kinds' shipped entries arrive with `content-designer` on this branch; until then the
 * plant uses bench-only entries (game-design: bench data, never a product), the same data as
 * `sim-core`'s test entries (`src/testing/lighting.ts`).
 */

export const LIGHTING_CIRCUITS = 30;
const LIGHTING_SMOKE_CIRCUITS = 3;

const ref = (id: string) => ({ id, version: 1 });
const DIMMER = ref('dimmer.bench-wall');
const HOLDER = ref('lampholder.bench-e26');
const A19 = ref('lamp.bench-a19-60w');
const LED = ref('light.bench-led-a19');
const SERVICE = ref('utility.larkmoor-split-phase-25kva');
const LEAD = ref('lead.quillfern-test-1m');

const at = (x: number, y = 0, z = 0) => ({ x, y, z });
const terminal = (id: string, x = 0) => ({
  id,
  label: id,
  positionMm: at(x),
  methods: [],
  role: null,
  side: null,
  access: 'clip',
});
const sources = (covers: string[]) => [
  { id: 'bench', kind: 'game-design', citation: 'game-design: bench data', covers },
];

function entry(
  r: { id: string; version: number },
  kind: string,
  terminals: readonly string[],
  params: Record<string, number>,
  overrides: Record<string, unknown> = {},
  covers: string[] = [],
): Record<string, unknown> {
  return {
    ...r,
    title: 'Bench lighting device',
    brand: 'Benchmark',
    modelName: 'B-1',
    category: 'load',
    sizeMm: { widthMm: 20, heightMm: 20, depthMm: 20 },
    terminals: terminals.map((t, i) => terminal(t, 10 * i)),
    mounts: [],
    enclosure: null,
    hostMounts: [],
    outlets: [],
    plug: null,
    supersededBy: null,
    conductor: null,
    model: { kind, params },
    controls: [],
    sources: sources(['sizeMm', 'terminals', ...Object.keys(params).map((p) => `model.params.${p}`), ...covers]),
    extensions: {},
    ...overrides,
  };
}

const E26_FIT = {
  type: 'e26',
  widthMm: 20,
  crossMm: 0,
  alongMm: 0,
  contacts: [
    { id: 'foot', terminal: 'a', host: 'centre', positionOffset: 0, contactOhm: 0.002 },
    { id: 'shell', terminal: 'b', host: 'shell', positionOffset: 0, contactOhm: 0.002 },
  ],
};
const E26_COVERS = ['fits.e26', 'fits.e26.contacts.foot.contactOhm', 'fits.e26.contacts.shell.contactOhm'];

const DOCUMENTS: readonly unknown[] = [
  entry(
    DIMMER,
    'dimmer.wall',
    ['ground', 'line', 'load'],
    { ratedVoltageV: 120, ratedPowerW: 600 },
    {
      controls: [
        { id: 'on', label: 'Switch', type: 'toggle' },
        { id: 'level', label: 'Level', type: 'setpoint', unit: 'level', min: 0, max: 1, step: 0.05 },
      ],
    },
  ),
  entry(
    HOLDER,
    'lampholder.e26',
    ['ground', 'hot', 'neutral'],
    { ratedPowerW: 660, ratedVoltageV: 250 },
    {
      hostMounts: [
        {
          id: 'socket',
          type: 'e26',
          positionMm: at(0),
          axis: '+x',
          facing: '+z',
          extentMm: 0,
          contacts: [
            { id: 'centre', terminal: 'hot' },
            { id: 'shell', terminal: 'neutral' },
          ],
          bus: null,
        },
      ],
    },
    ['mounts.socket'],
  ),
  entry(
    A19,
    'lamp.incandescent',
    ['a', 'b'],
    {
      ratedVoltageV: 120,
      ratedPowerW: 60,
      filamentRatedTempK: 2700,
      thermalTimeConstantMs: 30,
      conductionFraction: 0.05,
    },
    { mounts: [E26_FIT] },
    E26_COVERS,
  ),
  entry(
    LED,
    'light.led',
    ['a', 'b'],
    { ratedVoltageV: 120, ratedPowerW: 9, powerFactor: 0.9, dropoutVoltageV: 90, restartVoltageV: 95 },
    { mounts: [E26_FIT] },
    E26_COVERS,
  ),
];

let catalog: Catalog | null = null;
function lightingCatalog(): Catalog {
  catalog ??= catalogOrThrow(BUILTIN_CATALOG.version, {
    devices: [...BUILTIN_CATALOG.devices, ...DOCUMENTS],
    tables: BUILTIN_CATALOG.tables,
  });
  return catalog;
}

interface LightingRig {
  readonly bus: CommandBus<World>;
  readonly engine: SimEngine;
  /** The first circuit's dimmer. */
  readonly dimmer: number;
}

function exec(rig: { bus: CommandBus<World>; engine: SimEngine | null }, id: string, args: object): void {
  const result = rig.bus.exec(id, args);
  if (!result.ok) throw new Error(`lighting bench: ${id} ${JSON.stringify(args)}: ${JSON.stringify(result.error)}`);
  if (result.logged && rig.engine !== null) rig.engine.applied(result.entry, rig.bus.state);
}

/** The plant of `circuits` circuits (see the file comment), settled 500 ms. */
function buildLighting(circuits: number): LightingRig {
  const bus = createWorldBus(createWorld({ seed: 12 }), createWorldRegistry({ catalog: lightingCatalog() }));
  const rig: { bus: CommandBus<World>; engine: SimEngine | null } = { bus, engine: null };
  const place = (r: { id: string; version: number }, x: number, mountedOn: object | null = null): number => {
    exec(rig, 'entity.place', { ref: r, positionMm: at(x), mountedOn });
    return bus.state.nextEntityId - 1;
  };
  const lead = (a: number, ta: string, b: number, tb: string) =>
    exec(rig, 'lead.connect', { ref: LEAD, a: { entity: a, terminal: ta }, b: { entity: b, terminal: tb } });
  const service = place(SERVICE, 0);
  let first = -1;
  for (let c = 0; c < circuits; c++) {
    const leg = c % 2 === 0 ? 'l1' : 'l2';
    const x = 2000 + 1000 * c;
    const dimmer = place(DIMMER, x);
    if (first < 0) first = dimmer;
    for (const [k, bulb] of [A19, LED, A19].entries()) {
      const holder = place(HOLDER, x + 200 * (k + 1));
      place(bulb, x + 200 * (k + 1), { entity: holder, mount: 'socket' });
      if (k === 0) lead(dimmer, 'load', holder, 'hot');
      else lead(service, leg, holder, 'hot');
      lead(holder, 'neutral', service, 'n');
    }
    lead(service, leg, dimmer, 'line');
    exec(rig, 'device.operate', { id: dimmer, control: 'on', value: true });
    exec(rig, 'device.operate', { id: dimmer, control: 'level', value: 0.5 });
  }
  const engine = SimEngine.start(bus.state, { catalog: lightingCatalog() });
  rig.engine = engine;
  engine.advanceTo(500);
  bus.advanceTo(500);
  return { bus, engine, dimmer: first };
}

let rig: LightingRig | null = null;
let smokeRig: LightingRig | null = null;
function lightingRig(smoke?: boolean): LightingRig {
  if (smoke === true) return (smokeRig ??= buildLighting(LIGHTING_SMOKE_CIRCUITS));
  return (rig ??= buildLighting(LIGHTING_CIRCUITS));
}
let current: LightingRig | null = null;

const operate = (r: LightingRig, control: string, value: boolean | number) =>
  exec({ bus: r.bus, engine: r.engine }, 'device.operate', { id: r.dimmer, control, value });

/** What a re-solve decided: the topology, each island's phasor solves and status, a digest of the bags. */
function digest(r: LightingRig): string {
  const islands = r.engine.islands().map((i) => `${i.iterations}${i.status[0]}`);
  let running = 0;
  for (const { state } of r.engine.exportState().entities) if (state['running'] === true) running++;
  return `${r.engine.netlist.topologyHash.slice(0, 16)}:${islands.join(',')}:${running}:${r.engine.lastSolveTick}`;
}

/** `lighting-resolve-topology-change` and `lighting-level-change` (see the file comment). */
export function lightingCases(budgetMs: number, calibration: BenchCalibration): BenchCase[] {
  return [
    {
      name: 'lighting-resolve-topology-change',
      warmup: 10,
      runs: 51,
      budgetMs,
      calibration,
      prepare: (smoke) => {
        current = lightingRig(smoke);
        operate(current, 'on', true);
      },
      run: () => {
        operate(current as LightingRig, 'on', false);
        return digest(current as LightingRig);
      },
    },
    {
      name: 'lighting-level-change',
      warmup: 10,
      runs: 51,
      budgetMs: null,
      prepare: (smoke) => {
        current = lightingRig(smoke);
        operate(current, 'on', true);
        operate(current, 'level', 0.5);
      },
      run: () => {
        operate(current as LightingRig, 'level', 0.8);
        return digest(current as LightingRig);
      },
    },
  ];
}

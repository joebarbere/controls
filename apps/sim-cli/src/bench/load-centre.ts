import { BUILTIN_CATALOG, type Catalog, catalogOrThrow } from '@controls/catalog';
import { createWorld, type ReplayEntry, type World } from '@controls/save-format';
import { compileNetlist, type Netlist, SimEngine } from '@controls/sim-core';
import { createWorldBus, createWorldRegistry } from '@controls/world-model';
import type { BenchCase } from './bench';

/*
 * P4 PR 14a's bench cases: the load centre's netlist models at the scale of the 2,000-node plant
 * (ADR 0019's P4 PR 14 amendment). `PANELS` panels, each a split-phase utility feeding a 20-space load
 * centre through a two-pole main on `mainFeed`, its main bonding jumper and ground bar kit mounted, and
 * a 1500 W heater on every space through its own breaker, from the breaker's load screw back to its own
 * neutral-bar terminal. Each panel adds 20 stab contacts, 2 feed contacts, 3 bond contacts and two bar
 * join groups (the neutral bar's 21 terminals, the ground bar's 11) to what a plain circuit would have:
 * about 93 nodes and 115 branches per panel, so 21 panels are about 1,950 nodes.
 *
 * - `load-centre-plant-compile`: a from-scratch compile, as on a load (reported).
 * - `load-centre-plant-handle-resolve`: one branch breaker's handle turned off on the warm engine, the
 *   recompile (a structural change: the pole leaves the netlist) and the AC re-solve of every island,
 *   with the connection bank in the loop, as a player's click runs it (reported; spec §4.5's gated
 *   re-solve on a house is `house-trip-resolve`, pending F4.6 part 2).
 *
 * The entries are BENCH DATA, defined here so the bench needs no test helper; they are not content
 * (PR 14 ships the real load centre). Contact and pole values are the test entries' (`game-design:
 * bench`).
 */

/** Panels in the plant: about 2,000 nodes (spec §4.5's plant size). */
export const LOAD_CENTRE_PANELS = 21;
/** The smoke run's plant. */
export const LOAD_CENTRE_SMOKE_PANELS = 2;
const SPACES = 20;
const ROWS = SPACES / 2;

const UTILITY = { id: 'utility.larkmoor-split-phase-25kva', version: 1 };
const HEATER = { id: 'heater.hearthvale-120v-1500w', version: 1 };
const LEAD = { id: 'lead.quillfern-test-1m', version: 1 };
const PANEL = { id: 'panel.bench-lc-20', version: 1 };
const MAIN = { id: 'breaker.bench-main-2p-100a', version: 1 };
const BRANCH = { id: 'breaker.bench-1p-20a', version: 1 };
const MBJ = { id: 'bond.bench-mbj', version: 1 };
const GROUND_BAR = { id: 'bond.bench-ground-bar', version: 1 };

const at = (x: number, y = 0, z = 0) => ({ x, y, z });
interface TerminalDoc {
  readonly id: string;
  readonly label: string;
  readonly positionMm: { x: number; y: number; z: number };
  readonly methods: readonly unknown[];
  readonly role: 'grounded' | 'egc' | null;
  readonly side: null;
  readonly access: string;
}
const terminal = (id: string, access: 'clip' | 'none' = 'clip'): TerminalDoc => ({
  id,
  label: id,
  positionMm: at(0),
  methods: [],
  role: null,
  side: null,
  access,
});
const screw = {
  method: 'screw',
  ratedConductors: 1,
  maxConductors: 1,
  awgRange: { smallest: 14, largest: 10 },
  stranding: ['solid', 'stranded'],
  stripLengthMm: { nominal: 13, tolerance: 2 },
  torqueNm: 1.4,
  drives: ['slotted', 'phillips'],
  alRated: false,
  entryMm: at(10, 0, 5),
  exitAxis: '+z',
  clampType: 'bindingScrew',
  clampDepthMm: 10,
  contactOhm: 0.0003,
  heatPathWPerK: 0.026,
  hotSpotHeatCapacityJPerK: 1.1,
  multiConductor: null,
  combination: null,
};
const landed = (id: string, role: 'grounded' | 'egc' | null): TerminalDoc => ({
  ...terminal(id),
  methods: [screw],
  role,
  access: 'land',
});

function entry(
  ref: { id: string; version: number },
  kind: string,
  terminals: readonly TerminalDoc[],
  overrides: Record<string, unknown>,
  covers: string[],
  params: Record<string, number> = {},
): Record<string, unknown> {
  return {
    ...ref,
    title: 'Bench load-centre part',
    brand: 'Benchbrand',
    modelName: 'BLC-1',
    category: 'protection',
    sizeMm: { widthMm: 20, heightMm: 40, depthMm: 20 },
    terminals,
    mounts: [],
    enclosure: null,
    hostMounts: [],
    outlets: [],
    plug: null,
    supersededBy: null,
    conductor: null,
    model: { kind, params },
    controls: [],
    ...overrides,
    sources: [
      {
        id: 'bench',
        kind: 'game-design',
        citation: 'game-design: bench data (sim bench), never content',
        covers: [
          'sizeMm',
          'terminals',
          ...terminals.filter((t) => t.methods.length > 0).map((t) => `terminals.${t.id}.methods.screw`),
          ...Object.keys(params).map((p) => `model.params.${p}`),
          ...covers,
        ],
      },
    ],
    extensions: {},
  };
}

const fit = (
  type: string,
  contacts: { id: string; terminal: string; host: string; offset?: number }[],
  ohm: number,
) => ({
  type,
  widthMm: 20,
  crossMm: 0,
  alongMm: 0,
  contacts: contacts.map((c) => ({
    id: c.id,
    terminal: c.terminal,
    host: c.host,
    positionOffset: c.offset ?? 0,
    contactOhm: ohm,
  })),
});
const covers = (type: string, ids: string[]) => [
  `fits.${type}`,
  ...ids.map((id) => `fits.${type}.contacts.${id}.contactOhm`),
];
const single = (id: string, type: string, x: number, contacts: { id: string; terminal: string }[]) => ({
  id,
  type,
  positionMm: at(x),
  axis: '+x',
  facing: '+z',
  extentMm: 0,
  contacts,
  bus: null,
});
const column = (id: string, y: number) => ({
  id,
  type: 'busStab',
  positionMm: at(0, y),
  axis: '+x',
  facing: '+z',
  extentMm: ROWS * 25,
  contacts: [],
  bus: { pitchMm: 25, stabs: ROWS, legs: ['busL1', 'busL2'] },
});
const plugOn = (ratedA: number, minA: number, maxA: number, poleOhm: number) => ({
  ratedCurrentA: ratedA,
  thermalTimeConstantS: 60,
  ultimateTripRatio: 1.25,
  magneticPickupMinA: minA,
  magneticPickupMaxA: maxA,
  openingTimeMinMs: 8,
  openingTimeMaxMs: 20,
  contactResistanceOhm: poleOhm,
});
const HANDLE = [{ id: 'on', label: 'Handle on', type: 'toggle' }];

const DOCUMENTS: readonly Record<string, unknown>[] = [
  entry(
    PANEL,
    'enclosure.loadCentre',
    [
      terminal('busL1'),
      terminal('busL2'),
      terminal('chassis'),
      landed('neutral', 'grounded'),
      ...Array.from({ length: SPACES }, (_, i) => landed(`n${i + 1}`, 'grounded')),
    ],
    {
      category: 'enclosure',
      sizeMm: { widthMm: 500, heightMm: 600, depthMm: 100 },
      enclosure: {
        mounts: [
          column('left', 0),
          column('right', 100),
          single('main', 'mainFeed', 300, [
            { id: 'l1', terminal: 'busL1' },
            { id: 'l2', terminal: 'busL2' },
          ]),
          single('mbj', 'mbj', 400, [
            { id: 'neutral', terminal: 'neutral' },
            { id: 'chassis', terminal: 'chassis' },
          ]),
          single('groundBar', 'groundBarKit', 450, [{ id: 'chassis', terminal: 'chassis' }]),
        ],
        entries: [],
        interiorVolumeMm3: 30_000_000,
        markedVolumeMm3: null,
        material: 'steel',
        spaces: Array.from({ length: SPACES }, (_, i) => ({ mount: i % 2 === 0 ? 'left' : 'right', index: i >> 1 })),
      },
      controls: [{ id: 'coverOn', label: 'Dead front', type: 'toggle' }],
    },
    ['mounts', 'interiorVolumeMm3', 'material', 'spaces'],
  ),
  entry(
    MAIN,
    'breaker.plugOn2p',
    [landed('line1', null), landed('line2', null), terminal('load1', 'none'), terminal('load2', 'none')],
    {
      mounts: [
        fit(
          'mainFeed',
          [
            { id: 'load1', terminal: 'load1', host: 'l1' },
            { id: 'load2', terminal: 'load2', host: 'l2' },
          ],
          0.0005,
        ),
      ],
      controls: HANDLE,
    },
    covers('mainFeed', ['load1', 'load2']),
    plugOn(100, 2000, 3000, 0.001),
  ),
  entry(
    BRANCH,
    'breaker.plugOn1p',
    [terminal('line', 'none'), landed('load', null)],
    { mounts: [fit('busStab', [{ id: 'line1', terminal: 'line', host: 'stab' }], 0.005)], controls: HANDLE },
    covers('busStab', ['line1']),
    plugOn(20, 240, 400, 0.005),
  ),
  entry(
    MBJ,
    'bond.jumper',
    [terminal('body', 'none')],
    {
      mounts: [
        fit(
          'mbj',
          [
            { id: 'chassis', terminal: 'body', host: 'chassis' },
            { id: 'neutral', terminal: 'body', host: 'neutral' },
          ],
          0.002,
        ),
      ],
    },
    covers('mbj', ['chassis', 'neutral']),
  ),
  entry(
    GROUND_BAR,
    'bond.groundBar',
    [terminal('bar'), ...Array.from({ length: 10 }, (_, i) => landed(`g${i + 1}`, 'egc'))],
    { mounts: [fit('groundBarKit', [{ id: 'chassis', terminal: 'bar', host: 'chassis' }], 0.002)] },
    covers('groundBarKit', ['chassis']),
  ),
];

let catalog: Catalog | null = null;

/** The built-in catalogue plus the bench's load-centre entries. */
export function loadCentreBenchCatalog(): Catalog {
  catalog ??= catalogOrThrow(BUILTIN_CATALOG.version, {
    devices: [...BUILTIN_CATALOG.devices, ...DOCUMENTS],
    cables: BUILTIN_CATALOG.cables,
    tools: BUILTIN_CATALOG.tools,
    accessories: BUILTIN_CATALOG.accessories,
    tables: BUILTIN_CATALOG.tables,
    rules: BUILTIN_CATALOG.ruleSets,
  });
  return catalog;
}

/** The plant and the two worlds the handle case moves between, with the commands that make them. */
export interface LoadCentrePlant {
  /** Every handle on. */
  readonly closed: World;
  /** The first panel's space-1 breaker off, and the logged entry that turned it off. */
  readonly open: World;
  readonly openEntry: ReplayEntry;
  /** The same breaker on again (a world equal to `closed`, another object), and its entry. */
  readonly reclosed: World;
  readonly recloseEntry: ReplayEntry;
}

/** Builds the plant of `panels` panels with the world commands (see the file comment). */
export function buildLoadCentrePlant(panels = LOAD_CENTRE_PANELS): LoadCentrePlant {
  const bus = createWorldBus(createWorld({ seed: 14 }), createWorldRegistry({ catalog: loadCentreBenchCatalog() }));
  const exec = (id: string, args: object) => {
    const result = bus.exec(id, args);
    if (!result.ok) throw new Error(`load-centre plant: ${id} ${JSON.stringify(args)}: ${result.error.message}`);
    return result;
  };
  const place = (ref: object, positionMm: object, mountedOn: object | null = null): number => {
    exec('entity.place', { ref, positionMm, mountedOn });
    return bus.state.nextEntityId - 1;
  };
  const lead = (a: number, ta: string, b: number, tb: string) =>
    exec('lead.connect', { ref: LEAD, a: { entity: a, terminal: ta }, b: { entity: b, terminal: tb } });
  const on = (id: number) => exec('device.operate', { id, control: 'on', value: true });
  let firstBranch = 0;
  for (let k = 0; k < panels; k++) {
    const z = 3000 * k;
    const utility = place(UTILITY, at(-1000, 0, z));
    const lc = place(PANEL, at(0, 0, z));
    const main = place(MAIN, at(300, 0, z), { entity: lc, mount: 'main' });
    place(MBJ, at(400, 0, z), { entity: lc, mount: 'mbj' });
    place(GROUND_BAR, at(450, 0, z), { entity: lc, mount: 'groundBar' });
    lead(utility, 'l1', main, 'line1');
    lead(utility, 'l2', main, 'line2');
    lead(utility, 'n', lc, 'neutral');
    on(main);
    for (let space = 1; space <= SPACES; space++) {
      const row = (space - 1) >> 1;
      const right = (space - 1) % 2 === 1;
      const breaker = place(BRANCH, at(25 * row, right ? 100 : 0, z), { entity: lc, mount: right ? 'right' : 'left' });
      if (firstBranch === 0) firstBranch = breaker;
      on(breaker);
      const heater = place(HEATER, at(1000 + 300 * space, 0, z));
      lead(breaker, 'load', heater, 'a');
      lead(heater, 'b', lc, `n${space}`);
    }
  }
  const closed = bus.state;
  const off = exec('device.operate', { id: firstBranch, control: 'on', value: false });
  const open = bus.state;
  const back = exec('device.operate', { id: firstBranch, control: 'on', value: true });
  if (!off.logged || !back.logged) throw new Error('load-centre plant: the handle commands must be logged');
  return { closed, open, openEntry: off.entry, reclosed: bus.state, recloseEntry: back.entry };
}

const plants = new Map<number, LoadCentrePlant>();
const plantOf = (panels: number): LoadCentrePlant => {
  let plant = plants.get(panels);
  if (plant === undefined) {
    plant = buildLoadCentrePlant(panels);
    plants.set(panels, plant);
  }
  return plant;
};

function netlistChecksum(netlist: Netlist): string {
  const contacts = netlist.branches.filter((b) => b.element.kind === 'contact').length;
  return `${netlist.nodes.length}:${netlist.branches.length}:${contacts}:${netlist.islands.length}:${netlist.topologyHash}`;
}

let compilePanels = LOAD_CENTRE_PANELS;

/** `load-centre-plant-compile` (see the file comment). */
export const LOAD_CENTRE_COMPILE_CASE: BenchCase = {
  name: 'load-centre-plant-compile',
  warmup: 10,
  runs: 51,
  budgetMs: null,
  prepare: (smoke) => {
    compilePanels = smoke === true ? LOAD_CENTRE_SMOKE_PANELS : LOAD_CENTRE_PANELS;
  },
  run: () => netlistChecksum(compileNetlist(plantOf(compilePanels).closed, loadCentreBenchCatalog())),
};

let handleEngine: { engine: SimEngine; panels: number } | null = null;

/** `load-centre-plant-handle-resolve` (see the file comment). */
export const LOAD_CENTRE_HANDLE_CASE: BenchCase = {
  name: 'load-centre-plant-handle-resolve',
  warmup: 10,
  runs: 51,
  budgetMs: null,
  prepare: (smoke) => {
    const panels = smoke === true ? LOAD_CENTRE_SMOKE_PANELS : LOAD_CENTRE_PANELS;
    const plant = plantOf(panels);
    if (handleEngine === null || handleEngine.panels !== panels) {
      handleEngine = { engine: SimEngine.start(plant.closed, { catalog: loadCentreBenchCatalog() }), panels };
    }
    // Back to every handle on (untimed): the reclose entry at the same tick, a structural recompile.
    handleEngine.engine.applied(plant.recloseEntry, plant.reclosed);
  },
  run: () => {
    const { engine, panels } = handleEngine as { engine: SimEngine; panels: number };
    const plant = plantOf(panels);
    engine.applied(plant.openEntry, plant.open);
    return `${netlistChecksum(engine.netlist)}:${engine.stats.commandSolves > 0}`;
  },
};

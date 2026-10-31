import { createWorld, migrateWorld, type World } from '@controls/save-format';
import { materialiseWorld, NOMINAL_BANDS } from '@controls/sim-protocol';
import { AC_SOURCE, BATTERY, benchLamp, end, LAMP, LEAD, origin } from '../../testing/bench';
import { ENGINE_BENCH, engineBus, engineTestOptions, FLIP, OPAQUE, RHEOSTAT, TWIN_SUPPLY } from '../../testing/engine';
import type { SimDeviceModel } from './device-model';
import { formatNetlist } from '../netlist/format';
import { formatEngineDump, formatIslandDiagnostic, formatIslandFlags, netlistDump } from './dump';
import { SimEngine, type SimEngineOptions, type SimIslandDiagnostic } from './engine';

/*
 * `netlist.dump` (plan F2.6): the text is `formatNetlist` plus one `solve island` line per island,
 * from the solution the engine holds. The bench scenarios' full goldens are in `apps/sim-cli`
 * (`src/goldens/netlist-dump/`); here each status and reason is pinned on a small circuit.
 */

type Commands = readonly (readonly [string, object])[];

/** A world bus on the engine test catalogue, an engine following it, the commands run, then `ticks`. */
function session(commands: Commands, ticks = 0, options: SimEngineOptions = engineTestOptions()) {
  const bus = engineBus();
  const engine = SimEngine.start(bus.state, options);
  for (const [id, args] of commands) {
    const result = bus.exec(id, args);
    if (!result.ok) throw new Error(`${id}: ${result.error.message}`);
    if (result.logged) engine.applied(result.entry, bus.state);
  }
  engine.advanceTo(ticks);
  bus.advanceTo(ticks);
  return { bus, engine, world: (): World => materialiseWorld(bus.state, engine.exportState()) };
}

const solveLines = (text: string) => text.split('\n').filter((line) => line.startsWith('solve island '));

describe('netlist.dump', () => {
  it('names the island flags', () => {
    expect(formatIslandFlags(0)).toBe('none');
    expect(formatIslandFlags(1)).toBe('singular');
    expect(formatIslandFlags(2)).toBe('nonConverged');
    expect(formatIslandFlags(3)).toBe('singular,nonConverged');
    expect(formatIslandFlags(4 | 1)).toBe('singular,4');
  });

  it('writes a band it has no name for as its index, never a wrong name', () => {
    const island: SimIslandDiagnostic = {
      index: 3,
      kind: 'dc',
      status: 'solved',
      flags: 0,
      iterations: 2,
      referenceNode: 7,
      unknowns: 5,
      band: NOMINAL_BANDS.length,
      bandReason: null,
      unvalued: [],
      dcSources: [],
      acSources: [],
    };
    expect(formatIslandDiagnostic(island)).toBe(
      `solve island 3 solved flags none iterations 2 reference 7 unknowns 5 band #${NOMINAL_BANDS.length}`,
    );
    expect(formatIslandDiagnostic({ ...island, band: 1 })).toMatch(/ band dc12$/);
    expect(formatIslandDiagnostic({ ...island, band: 0, bandReason: 'sources-disagree' })).toMatch(
      / band none \(sources-disagree\)$/,
    );
  });

  it('of an empty world: no islands and no solution', () => {
    expect(netlistDump(createWorld({ seed: 3 }))).toMatch(
      /^netlist\.dump tick 0\nnetlist 0 nodes, 0 branches, 0 islands\ntopology [0-9a-f]{64}\nsolution none\n$/,
    );
  });

  it('is formatNetlist, then the solution tick, then one line per island', () => {
    const { engine } = session(ENGINE_BENCH, 37);
    const text = formatEngineDump(engine);
    expect(text.startsWith(`netlist.dump tick 37\n${formatNetlist(engine.netlist)}solution tick 30\n`)).toBe(true);
    // Seven nodes (the closed switch joins its two terminals), one reference, one source current.
    expect(engine.netlist.nodes).toHaveLength(7);
    expect(solveLines(text)).toEqual([
      'solve island 0 solved flags none iterations 1 reference 0 unknowns 7 band dc12',
    ]);
    expect(text.endsWith('band dc12\n')).toBe(true);
  });

  it('says which branch no model can value: unmodelled, never a reading', () => {
    // A battery into the opaque test load, which no device model values (the lamp did until F2.5).
    const { world } = session([
      ['entity.place', { ref: BATTERY, positionMm: origin }],
      ['entity.place', { ref: OPAQUE, positionMm: origin }],
      ['lead.connect', { ref: LEAD, a: end(1, 'pos'), b: end(2, 'a') }],
      ['lead.connect', { ref: LEAD, a: end(2, 'b'), b: end(1, 'neg') }],
    ]);
    expect(solveLines(netlistDump(world(), engineTestOptions()))).toEqual([
      'solve island 0 unmodelled flags none iterations 0 reference none unknowns 0 band dc12 unvalued 1',
    ]);
  });

  it('forgets a branch that was unvalued once a later value pass values it (same netlist)', () => {
    // A rheostat that declines to value itself above 1 MΩ (and has no default), so a values-only change
    // (device.operate, no rebuild) moves which branch is unvalued on the same netlist.
    const options = engineTestOptions();
    const picky: SimDeviceModel = {
      kind: 'test.rheostat',
      output: null,
      bank: () => ({
        bag: () => ({}),
        dcValue: (_i, b, values) => {
          if (b.values['ohms'] > 1e6) return false;
          values.resistor(b.index, b.values['ohms']);
          return true;
        },
      }),
    };
    const withPicky = { ...options, deviceModels: { ...options.deviceModels, 'test.rheostat': picky } };
    const operate = (id: number, ohms: number): readonly [string, object] => [
      'device.operate',
      { id, control: 'ohms', value: ohms },
    ];
    // Battery (branch 0) → rheostat 2 (branch 1) → rheostat 3 (branch 2) → battery.
    const loop: Commands = [
      ['entity.place', { ref: BATTERY, positionMm: origin }],
      ['entity.place', { ref: RHEOSTAT, positionMm: origin }],
      ['entity.place', { ref: RHEOSTAT, positionMm: origin }],
      ['lead.connect', { ref: LEAD, a: end(1, 'pos'), b: end(2, 'a') }],
      ['lead.connect', { ref: LEAD, a: end(2, 'b'), b: end(3, 'a') }],
      ['lead.connect', { ref: LEAD, a: end(3, 'b'), b: end(1, 'neg') }],
      operate(2, 1e7),
    ];
    const first = session(loop, 0, withPicky);
    expect(solveLines(formatEngineDump(first.engine))).toEqual([
      'solve island 0 unmodelled flags none iterations 0 reference none unknowns 0 band dc12 unvalued 1',
    ]);
    const generation = first.engine.topologyGeneration;
    const second = session([...loop, operate(2, 10), operate(3, 1e7)], 0, withPicky);
    expect(second.engine.topologyGeneration).toBe(generation); // values only: no rebuild
    expect(solveLines(formatEngineDump(second.engine))).toEqual([
      'solve island 0 unmodelled flags none iterations 0 reference none unknowns 0 band dc12 unvalued 2',
    ]);
  });

  it('solves the bench lamp since F2.5, at the world tick on the way in', () => {
    const text = netlistDump(benchLamp(true));
    expect(text).toContain('branch 1 e3.filament resistor lamp.incandescent 3 -> 4 island 0');
    expect(solveLines(text)).toEqual([
      expect.stringMatching(
        /^solve island 0 solved flags none iterations [1-9]\d* reference 0 unknowns \d+ band dc12$/,
      ),
    ]);
    // Solved at the world's tick on the way in (the world was never materialised).
    expect(text).toContain('\nsolution tick 0\n');
  });

  it('lists a mixed island’s DC and AC sources', () => {
    const { world } = session([
      ['entity.place', { ref: BATTERY, positionMm: origin }],
      ['entity.place', { ref: AC_SOURCE, positionMm: origin }],
      ['lead.connect', { ref: LEAD, a: end(1, 'pos'), b: end(2, 'l') }],
      ['lead.connect', { ref: LEAD, a: end(2, 'n'), b: end(1, 'neg') }],
    ]);
    const text = netlistDump(world(), engineTestOptions());
    expect(text).toContain('diagnostic mixed-island island 0');
    expect(solveLines(text)).toEqual([
      'solve island 0 mixed flags none iterations 0 reference none unknowns 0 band none (mixed) sources dc 0 ac 1',
    ]);
  });

  it('flags singular and non-converged islands', () => {
    const singular = session([
      ['entity.place', { ref: TWIN_SUPPLY, positionMm: origin }],
      ['entity.place', { ref: LAMP, positionMm: origin }],
    ]);
    const unsettled = session([
      ['entity.place', { ref: BATTERY, positionMm: origin }],
      ['entity.place', { ref: FLIP, positionMm: origin }],
      ['lead.connect', { ref: LEAD, a: end(1, 'pos'), b: end(2, 'a') }],
      ['lead.connect', { ref: LEAD, a: end(2, 'b'), b: end(1, 'neg') }],
    ]);
    expect(solveLines(formatEngineDump(singular.engine))[0]).toMatch(
      /^solve island 0 singular flags singular iterations [1-9]\d* reference \d+ unknowns \d+ band none \(unrated-source\)$/,
    );
    expect(solveLines(formatEngineDump(unsettled.engine))).toEqual([
      expect.stringMatching(/^solve island 0 nonConverged flags nonConverged iterations [1-9]\d* reference 0 /),
    ]);
  });

  it('a loaded engine says what the straight run says, and taking a dump changes nothing', () => {
    // The bench plus an unwired opaque load: its own island, unmodelled (the loaded engine must say why
    // too; a lamp is modelled since F2.5).
    const bench: Commands = [...ENGINE_BENCH, ['entity.place', { ref: OPAQUE, positionMm: origin }]];
    const live = session(bench, 123);
    const control = session(bench, 123);
    const text = formatEngineDump(live.engine);
    expect(solveLines(text)[1]).toBe(
      'solve island 1 unmodelled flags none iterations 0 reference none unknowns 0 band none (no-source) unvalued 3',
    );
    const saved = migrateWorld(JSON.parse(JSON.stringify(live.world())));
    if (!saved.ok) throw new Error(saved.error.message);
    expect(netlistDump(saved.value, engineTestOptions())).toBe(text);
    expect(live.engine.snapshot()).toStrictEqual(control.engine.snapshot());
    for (const target of [130, 151, 400]) {
      live.engine.advanceTo(target);
      control.engine.advanceTo(target);
      formatEngineDump(live.engine);
      expect(live.engine.snapshot()).toStrictEqual(control.engine.snapshot());
      expect(live.engine.exportState()).toStrictEqual(control.engine.exportState());
    }
  });
});

import { z } from 'zod';
import { CommandBus } from './bus';
import { defaultBindingDecls } from './keybindings/defaults';
import { Keymap } from './keybindings/keymap';
import { CommandRegistry } from './registry';
import {
  DEFAULT_STEP_TICKS,
  MAX_STEP_TICKS,
  SIM_COMMAND_ARGS,
  SIM_PAUSE_BINDING,
  SIM_SPEED_1_BINDING,
  SIM_SPEED_10_BINDING,
  SIM_SPEED_60_BINDING,
  SIM_SPEEDS,
  SIM_STEP_COMMAND,
  SIM_STEP_LONG_BINDING,
  SIM_STEP_LONG_TICKS,
  SIM_STEP_SHORT_BINDING,
  SIM_STEP_SHORT_TICKS,
  SIM_TIME_WHEN,
  SimSetSpeedArgs,
  SimStepArgs,
  simCommands,
} from './sim-args';

describe('the sim time keys (ADR 0011 §13, F2.3b)', () => {
  const registry = new CommandRegistry<{ readonly tick: number }>().registerAll(simCommands());
  const keymap = Keymap.create(defaultBindingDecls(registry), {}, 'other');
  const running = { 'session.active': true, 'sim.status': 'running', 'sim.paused': false, 'sim.speed': 1 };
  const paused = { ...running, 'sim.status': 'paused', 'sim.paused': true, 'sim.speed': 0 };

  it('P pauses while running and resumes while paused: two bindings on disjoint whens', () => {
    expect(keymap.resolve('P', running)?.id).toBe(SIM_PAUSE_BINDING);
    expect(keymap.resolve('P', paused)?.id).toBe('sim.resume');
    expect(keymap.conflicts).toEqual([]);
  });

  it('Shift+1/2/3 set 1×, 10× and 60×; Period and Shift+Period step 10 ticks and 1 000 ticks', () => {
    const target = (chord: string) => keymap.resolve(chord, running)?.decl.target;
    expect(target('Shift+1')).toMatchObject({ command: 'sim.setSpeed', args: { speed: 1 } });
    expect(target('Shift+2')).toMatchObject({ command: 'sim.setSpeed', args: { speed: 10 } });
    expect(target('Shift+3')).toMatchObject({ command: 'sim.setSpeed', args: { speed: 60 } });
    expect(target('Period')).toMatchObject({ command: SIM_STEP_COMMAND, args: { ticks: SIM_STEP_SHORT_TICKS } });
    expect(target('Shift+Period')).toMatchObject({ command: SIM_STEP_COMMAND, args: { ticks: SIM_STEP_LONG_TICKS } });
    for (const id of [
      SIM_SPEED_1_BINDING,
      SIM_SPEED_10_BINDING,
      SIM_SPEED_60_BINDING,
      SIM_STEP_SHORT_BINDING,
      SIM_STEP_LONG_BINDING,
    ]) {
      const decl = keymap.get(id)?.decl;
      if (decl?.target.kind !== 'command') throw new Error(`${id} has no command target`);
      expect(registry.get(decl.target.command)?.args.safeParse(decl.target.args).success).toBe(true);
    }
  });

  it('do nothing without a game, or while the sim has crashed', () => {
    for (const chord of ['P', 'Shift+1', 'Shift+2', 'Shift+3', 'Period', 'Shift+Period']) {
      expect(keymap.resolve(chord, {})).toBeNull();
      expect(keymap.resolve(chord, { ...running, 'sim.status': 'crashed' })).toBeNull();
      expect(keymap.resolve(chord, { ...paused, 'sim.status': 'crashed' })).toBeNull();
    }
    expect(registry.isEnabled('sim.setSpeed', { ...running, 'sim.status': 'crashed' })).toBe(false);
    expect(SIM_TIME_WHEN).toContain("sim.status != 'crashed'");
  });
});

describe('the sim time commands (ADR 0011 §13)', () => {
  const registry = () => new CommandRegistry<{ readonly tick: number }>().registerAll(simCommands());
  const bus = () => new CommandBus({ registry: registry(), initialState: { tick: 3 }, tickOf: (s) => s.tick });

  it('are sim.setSpeed, sim.resume and sim.step: no sim.pause (pausing is setSpeed 0)', () => {
    expect(
      registry()
        .list()
        .map((c) => c.id),
    ).toStrictEqual(['sim.resume', 'sim.setSpeed', 'sim.step']);
    expect(registry().has('sim.pause')).toBe(false);
    expect(SIM_STEP_COMMAND).toBe('sim.step');
    for (const def of simCommands()) expect(def.args).toBe(SIM_COMMAND_ARGS[def.id as keyof typeof SIM_COMMAND_ARGS]);
  });

  it('are logged and change neither the state nor the history', () => {
    const b = bus();
    const state = b.state;
    expect(b.exec('sim.setSpeed', { speed: 0 })).toMatchObject({ ok: true, entry: { seq: 0, tick: 3 } });
    expect(b.exec('sim.resume')).toMatchObject({ ok: true, entry: { seq: 1 } });
    expect(b.exec('sim.step', {})).toMatchObject({ ok: true, entry: { seq: 2, args: { ticks: DEFAULT_STEP_TICKS } } });
    expect(b.exec('sim.step', { ticks: 0 })).toMatchObject({ ok: false, error: { kind: 'invalid-args' } });
    expect(b.state).toBe(state);
    expect([b.canUndo, b.canRedo]).toStrictEqual([false, false]);
  });
});

describe('sim command arguments (ADR 0011 §13)', () => {
  it('sim.setSpeed takes 0, 1, 10 or 60 and nothing else', () => {
    for (const speed of SIM_SPEEDS) expect(SimSetSpeedArgs.parse({ speed })).toStrictEqual({ speed });
    for (const bad of [2, -1, 0.5, '1', null]) expect(SimSetSpeedArgs.safeParse({ speed: bad }).success).toBe(false);
    expect(SimSetSpeedArgs.safeParse({ speed: 1, extra: true }).success).toBe(false);
  });

  it('sim.setSpeed is one JSON Schema enum (the palette refuses anyOf)', () => {
    const schema = z.toJSONSchema(SimSetSpeedArgs) as unknown as { properties: { speed: Record<string, unknown> } };
    expect(schema.properties.speed['enum']).toStrictEqual([0, 1, 10, 60]);
    expect(schema.properties.speed['anyOf']).toBeUndefined();
  });

  it('sim.step takes 1 to MAX_STEP_TICKS whole ticks, default DEFAULT_STEP_TICKS', () => {
    expect(MAX_STEP_TICKS).toBe(600_000);
    expect(SimStepArgs.parse({})).toStrictEqual({ ticks: DEFAULT_STEP_TICKS });
    expect(SimStepArgs.parse({ ticks: MAX_STEP_TICKS })).toStrictEqual({ ticks: MAX_STEP_TICKS });
    for (const bad of [0, MAX_STEP_TICKS + 1, 1.5, -10])
      expect(SimStepArgs.safeParse({ ticks: bad }).success).toBe(false);
  });

  it('sim.resume takes no arguments', () => {
    expect(SIM_COMMAND_ARGS['sim.resume'].parse({})).toStrictEqual({});
    expect(SIM_COMMAND_ARGS['sim.resume'].safeParse({ speed: 1 }).success).toBe(false);
  });
});

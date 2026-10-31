import { z } from 'zod';
import { CommandBus } from './bus';
import { CommandRegistry } from './registry';
import {
  DEFAULT_STEP_TICKS,
  MAX_STEP_TICKS,
  SIM_COMMAND_ARGS,
  SIM_SPEEDS,
  SIM_STEP_COMMAND,
  SimSetSpeedArgs,
  SimStepArgs,
  simCommands,
} from './sim-args';

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

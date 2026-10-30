import { z } from 'zod';
import {
  DEFAULT_STEP_TICKS,
  MAX_STEP_TICKS,
  SIM_COMMAND_ARGS,
  SIM_SPEEDS,
  SimSetSpeedArgs,
  SimStepArgs,
} from './sim-args';

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

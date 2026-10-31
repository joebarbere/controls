import { CommandBus } from './bus';
import { CommandRegistry } from './registry';
import { SIM_RESTART_COMMAND, SIM_STATUS_KEY, simHostCommands } from './sim-host';

describe('the game host sim commands (F2.3b)', () => {
  const registry = new CommandRegistry<{ n: number }>().registerAll(simHostCommands());

  it('sim.restart is an unlogged UI command, offered only while the sim has crashed', () => {
    expect(simHostCommands().map((c) => c.id)).toEqual([SIM_RESTART_COMMAND]);
    const bus = new CommandBus({ registry, initialState: { n: 1 }, tickOf: () => 0 });
    expect(bus.exec(SIM_RESTART_COMMAND)).toMatchObject({ ok: true, logged: false, entry: null });
    expect(bus.entries).toEqual([]);
    expect(registry.isEnabled(SIM_RESTART_COMMAND, { [SIM_STATUS_KEY]: 'crashed' })).toBe(true);
    expect(registry.isEnabled(SIM_RESTART_COMMAND, { [SIM_STATUS_KEY]: 'running' })).toBe(false);
    expect(registry.isEnabled(SIM_RESTART_COMMAND, {})).toBe(false);
  });
});

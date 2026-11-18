import {
  afciHost,
  afciOptions,
  BUSBAR,
  ENGINE_TEST_CATALOG,
  engineTestOptions,
  GFCI_20,
  PLUG_ON_20,
  PLUG_ON_2P_20,
  RHEOSTAT,
  UTILITY_SPLIT,
} from '@controls/sim-core/testing';
import { type SimEvent, simEventDetail } from '@controls/sim-protocol';
import { createWorldRegistry } from '@controls/world-model';
import { createGame, type Game, loadGame } from './game';

/*
 * Protocol 8 through the scripting API (P4 PR 11, ADR 0011's protocol 8 amendment): `game.device`
 * decodes a plug-on breaker's record from the snapshot (state and cause by name, never the handle's
 * `on`), `game.on('sim')` delivers its `tripped` event with a typed cause, and `game.snapshot()` holds
 * the same bytes a reload writes. TEST-ONLY breaker entries (`@controls/sim-core/testing`, P4 PR 10's):
 * the real plug-on entries are P4 PR 14's.
 *
 * The circuit: the utility stand-in (1), L1 through a 20 A plug-on breaker (2) into a rheostat (3) and
 * back to N, on busbar links. At 12 Ω it carries 120 / 12.0127 Ω = 9.989 A (ADR 0021 §1's Z_LN and the
 * 5 mΩ pole); at 0.1 Ω its current is above any pickup in the 240–400 A band, so it opens magnetically
 * within its drawn 8–20 ms.
 */

function circuit(): { game: Game; events: SimEvent[] } {
  const game = createGame({
    seed: 11,
    registry: createWorldRegistry({ catalog: ENGINE_TEST_CATALOG }),
    engine: engineTestOptions(),
  });
  const events: SimEvent[] = [];
  game.on('sim', (event) => events.push(event));
  const at = { x: 0, y: 0, z: 0 };
  const ok = (id: string, args: object) => expect(game.exec(id, args).ok, id).toBe(true);
  ok('entity.place', { ref: UTILITY_SPLIT, positionMm: at });
  ok('entity.place', { ref: PLUG_ON_20, positionMm: at });
  ok('entity.place', { ref: RHEOSTAT, positionMm: at });
  const link = (a: number, ta: string, b: number, tb: string) =>
    ok('lead.connect', { ref: BUSBAR, a: { entity: a, terminal: ta }, b: { entity: b, terminal: tb } });
  link(1, 'l1', 2, 'line');
  link(2, 'load', 3, 'a');
  link(3, 'b', 1, 'n');
  ok('device.operate', { id: 3, control: 'ohms', value: 12 });
  ok('device.operate', { id: 2, control: 'on', value: true });
  return { game, events };
}

describe('protocol 8 in the scripting API', () => {
  it('game.device decodes a plug-on breaker’s record: its current, state and no cause', () => {
    const { game } = circuit();
    game.advance(200);
    const record = game.device(2);
    expect(record?.kind).toBe('breaker.plugOn1p');
    expect(Math.abs((record?.values['currentA'] as number) / 9.989 - 1)).toBeLessThan(0.001);
    expect(record?.values).toMatchObject({ state: 'on', tripCause: 'none', status: 'solved' });
  });

  it('a short trips it: the event carries a typed cause, the record reads tripped while the handle stays on', () => {
    const { game, events } = circuit();
    game.advance(10);
    expect(game.exec('device.operate', { id: 3, control: 'ohms', value: 0.1 }).ok).toBe(true);
    game.advance(40);
    const trip = events.find((e) => e.kind === 'tripped');
    expect(trip?.entity).toBe(2);
    expect(trip && simEventDetail(trip, 'tripped')?.cause).toBe('magnetic');
    expect(game.device(2)?.values).toMatchObject({ currentA: 0, state: 'tripped', tripCause: 'magnetic' });
    expect(game.world().entities.find((e) => e.id === 2)?.state['on']).toBe(true);
  });

  it('game.snapshot() and its hash are the same after a save and load (records are a function of the export)', () => {
    const { game } = circuit();
    game.advance(300);
    const result = loadGame(game.save(), {
      registry: createWorldRegistry({ catalog: ENGINE_TEST_CATALOG }),
      engine: engineTestOptions(),
    });
    if (!result.ok) throw new Error(result.error.message);
    const loaded = result.game;
    expect(loaded.snapshot()).toStrictEqual(game.snapshot());
    game.advance(100);
    loaded.advance(100);
    expect(loaded.device(2)).toStrictEqual(game.device(2));
  });
});

/*
 * Save-and-load parity of the protocol 8 records whose state is the subtlest (PR 11 review): a GFCI
 * with its test held (`testHeldSinceTick`, the held resistor's residual integrating), an AFCI with an
 * end arcing downstream (`arcExposure`, the downstream marks rebuilt after the load) and a 2-pole
 * breaker. At the save and after running on, the loaded game's snapshot and record equal the straight
 * run's, and so do its events from there.
 */
describe('protocol 8 records survive a save and load', () => {
  type Engine = Parameters<typeof createGame>[0]['engine'];

  /** A game on `world` (or a fresh one) with the test catalogue and `engine`, its events collected. */
  function game(engine: Engine, world?: Parameters<typeof createGame>[0]['world']) {
    const g = createGame({
      ...(world === undefined ? { seed: 11 } : { world }),
      registry: createWorldRegistry({ catalog: ENGINE_TEST_CATALOG }),
      engine,
    });
    const events: SimEvent[] = [];
    g.on('sim', (event) => events.push(event));
    return { g, events };
  }

  /** Saves `live`, loads it, and checks the loaded game against it now and `after` ticks on. */
  function checkParity(live: { g: Game; events: SimEvent[] }, engine: Engine, id: number, after: number) {
    const result = loadGame(live.g.save(), { registry: createWorldRegistry({ catalog: ENGINE_TEST_CATALOG }), engine });
    if (!result.ok) throw new Error(result.error.message);
    const loaded = result.game;
    const loadedEvents: SimEvent[] = [];
    loaded.on('sim', (event) => loadedEvents.push(event));
    expect(loaded.snapshot()).toStrictEqual(live.g.snapshot());
    expect(loaded.device(id)).toStrictEqual(live.g.device(id));
    const seen = live.events.length;
    live.g.advance(after);
    loaded.advance(after);
    expect(loaded.snapshot()).toStrictEqual(live.g.snapshot());
    expect(loaded.device(id)).toStrictEqual(live.g.device(id));
    expect(loadedEvents).toStrictEqual(live.events.slice(seen));
    return loaded;
  }

  const at = { x: 0, y: 0, z: 0 };
  const build = (g: Game, steps: readonly (readonly [string, object])[]) => {
    for (const [id, args] of steps) expect(g.exec(id, args).ok, id).toBe(true);
  };
  const link = (a: number, ta: string, b: number, tb: string) =>
    ['lead.connect', { ref: BUSBAR, a: { entity: a, terminal: ta }, b: { entity: b, terminal: tb } }] as const;

  it('a GFCI breaker with its test held: testHeld, the integral and the trip at the same tick', () => {
    const engine = engineTestOptions();
    const live = game(engine);
    build(live.g, [
      ['entity.place', { ref: UTILITY_SPLIT, positionMm: at }],
      ['entity.place', { ref: GFCI_20, positionMm: at }],
      ['entity.place', { ref: RHEOSTAT, positionMm: at }],
      link(1, 'l1', 2, 'line'),
      link(2, 'pigtail', 1, 'n'),
      link(2, 'load', 3, 'a'),
      link(3, 'b', 2, 'loadNeutral'),
      ['device.operate', { id: 3, control: 'ohms', value: 12 }],
      ['device.operate', { id: 2, control: 'on', value: true }],
    ]);
    live.g.advance(10);
    build(live.g, [['device.press', { id: 2, control: 'test' }]]);
    live.g.advance(1500);
    expect(live.g.device(2)?.values).toMatchObject({ testHeld: 'yes', state: 'on' });
    checkParity(live, engine, 2, 3000);
    expect(live.g.device(2)?.values).toMatchObject({ testHeld: 'no', state: 'tripped', tripCause: 'test' });
  });

  it('an AFCI breaker with an end arcing downstream: arcingDownstream and arcExposure', () => {
    const engine = afciOptions();
    // The circuit's hand-built world, materialised by an engine run on it (its bags filled), as a save holds it.
    const live = game(engine, afciHost('downstream', 0.4, 3).materialised());
    for (let k = 0; k < 40 && live.g.device(2)?.values['arcingDownstream'] !== 'yes'; k++) live.g.advance(100);
    expect(live.g.device(2)?.values).toMatchObject({ arcingDownstream: 'yes', state: 'on' });
    checkParity(live, engine, 2, 500);
  });

  it('a 2-pole breaker: both poles’ currents and fractions, one state', () => {
    const engine = engineTestOptions();
    const live = game(engine);
    build(live.g, [
      ['entity.place', { ref: UTILITY_SPLIT, positionMm: at }],
      ['entity.place', { ref: PLUG_ON_2P_20, positionMm: at }],
      ['entity.place', { ref: RHEOSTAT, positionMm: at }],
      ['entity.place', { ref: RHEOSTAT, positionMm: at }],
      link(1, 'l1', 2, 'line1'),
      link(1, 'l2', 2, 'line2'),
      link(2, 'load1', 3, 'a'),
      link(2, 'load2', 4, 'a'),
      link(3, 'b', 1, 'n'),
      link(4, 'b', 1, 'n'),
      ['device.operate', { id: 3, control: 'ohms', value: 1.2 }],
      ['device.operate', { id: 4, control: 'ohms', value: 24 }],
      ['device.operate', { id: 2, control: 'on', value: true }],
    ]);
    live.g.advance(1000);
    expect(live.g.device(2)?.values['pole1ThermalFraction'] as number).toBeGreaterThan(0);
    checkParity(live, engine, 2, 2000);
  });
});

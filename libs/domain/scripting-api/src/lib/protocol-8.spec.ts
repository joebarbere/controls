import {
  BUSBAR,
  ENGINE_TEST_CATALOG,
  engineTestOptions,
  PLUG_ON_20,
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

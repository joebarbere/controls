import { TestBed } from '@angular/core/testing';
import { loadGame } from '@controls/scripting-api';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeSimWorker } from '../testing/fake-sim-worker';
import { Session } from './session';
import { SIM_TRANSPORT, SIM_WORKER_FACTORY } from './sim-host';

/*
 * The game's load (through a worker) and the headless load agree on every frozen save (#58 review):
 * the same `replay.status` and reason, the same refusal, and the same `world.hash` for the game as
 * loaded. Both decide with `planLoad`; this pins that the worker path doesn't drift from it.
 */

const FIXTURES = join(process.cwd(), 'libs/domain/save-format/fixtures');
const saves = ['v1', 'v2'].flatMap((version) =>
  readdirSync(join(FIXTURES, version, 'ctrl'))
    .filter((name) => name.endsWith('.ctrl'))
    .map((name) => ({
      name: `${version}/${name}`,
      bytes: new Uint8Array(readFileSync(join(FIXTURES, version, 'ctrl', name))),
    })),
);

describe('the game load matches the headless load on every frozen save', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('finds the fixtures (generator health)', () => {
    expect(saves.length).toBeGreaterThanOrEqual(8);
  });

  it.each(saves.map((s) => [s.name, s.bytes] as const))('%s', async (_name, bytes) => {
    TestBed.configureTestingModule({
      providers: [
        { provide: SIM_WORKER_FACTORY, useValue: FakeSimWorker.factory().factory },
        { provide: SIM_TRANSPORT, useValue: 'message' },
      ],
    });
    const session = TestBed.inject(Session);
    const headless = loadGame(bytes);
    const game = await session.prepareLoad(bytes);
    if (!headless.ok) {
      expect(game.ok).toBe(false);
      if (!game.ok) expect(game.error.kind).toBe(headless.error.kind);
      return;
    }
    if (!game.ok) throw new Error(`the game refused a save headless loads: ${game.error.kind}`);
    const { replay } = game.prepared;
    expect({ status: replay.status, reason: 'reason' in replay ? replay.reason : null }).toEqual({
      status: headless.replay.status,
      reason: 'reason' in headless.replay ? headless.replay.reason : null,
    });
    expect(game.prepared.hash).toBe(headless.game.hash());
    expect(game.prepared.game.entries()).toEqual(headless.game.entries());
    game.prepared.dispose();
  });
});

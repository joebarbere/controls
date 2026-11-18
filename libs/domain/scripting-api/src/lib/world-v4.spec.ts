import { createWorldRegistry } from '@controls/world-model';
import { RESIDENTIAL_TEST_CATALOG, residentialBench } from '@controls/world-model/testing';
import { type ConsoleTarget, runConsoleScript, toConsoleScript } from './console-script';
import { createGame, type Game } from './game';

/*
 * The world v4 commands (P4 PR 8, ADR 0019) from a console file and a TypeScript script: both reach
 * the same pinned `world.hash`, and the palette spec (`libs/features/palette/src/lib/world-v4.spec.ts`)
 * reaches it again through generated argument forms. TEST-ONLY content: no receptacle, appliance, load
 * centre or GFCI exists before P4's content PRs, so this runs over world-model's
 * `RESIDENTIAL_TEST_CATALOG` from its residential bench, without the sim engine (the commanded world).
 *
 * The steps plug a kettle in, tape a white conductor's end red, write two directory lines (one the text
 * "null", one cleared with a bare null), press a GFCI's test button, unplug the kettle and plug the lamp
 * in, then undo the last plug and redo it.
 */

/** Pinned in `libs/features/palette/src/lib/world-v4.spec.ts` too: change both together. */
const HASH = 'e8f60acef5e3286c1b60457d11204573b5e614e0221d8eb7434ed976a58ddad3';

function benchGame(): Game {
  return createGame({
    world: residentialBench().state,
    registry: createWorldRegistry({ catalog: RESIDENTIAL_TEST_CATALOG }),
    engine: false,
  });
}

function target(game: Game): ConsoleTarget {
  return {
    registry: game.registry,
    world: () => game.world(),
    catalog: RESIDENTIAL_TEST_CATALOG,
    exec: (id, args) => game.exec(id, args),
    hash: () => game.hash(),
    netlistDump: () => game.netlistDump(),
    wireInfo: (id: number) => game.wireInfo(id),
  };
}

/** The console file (ADR 0019's positional order for every new command). */
const CONSOLE_FILE = `# World v4 commands on the residential bench.
plug.insert 2 1 top
wire.mark 1 b red
panel.directory 4 3 "KITCHEN COUNTER"
panel.directory 4 4 "null"
panel.directory 4 3 null
panel.directory 4 1 BATH
device.press 6 test
device.press 6 test
plug.remove 2
plug.insert 3 1 bottom
edit.undo
edit.redo
world.hash
`;

/** The same steps as a TypeScript script (`sim run script.ts` exports one like it). */
function script(game: Game): void {
  const ok = (result: ReturnType<Game['exec']>) => {
    if (!result.ok) throw new Error(result.error.message);
  };
  ok(game.exec('plug.insert', { appliance: 2, receptacle: 1, outlet: 'top' }));
  ok(game.exec('wire.mark', { id: 1, end: 'b', colour: 'red' }));
  ok(game.exec('panel.directory', { id: 4, space: 3, text: 'KITCHEN COUNTER' }));
  ok(game.exec('panel.directory', { id: 4, space: 4, text: 'null' }));
  ok(game.exec('panel.directory', { id: 4, space: 3, text: null }));
  ok(game.exec('panel.directory', { id: 4, space: 1, text: 'BATH' }));
  ok(game.exec('device.press', { id: 6, control: 'test' }));
  ok(game.exec('device.press', { id: 6, control: 'test' }));
  ok(game.exec('plug.remove', { appliance: 2 }));
  ok(game.exec('plug.insert', { appliance: 3, receptacle: 1, outlet: 'bottom' }));
  ok(game.exec('edit.undo', {}));
  ok(game.exec('edit.redo', {}));
}

describe('the world v4 commands from a console file and a script (TEST-ONLY catalogue)', () => {
  it('the console file runs every new command in its positional form', async () => {
    const game = benchGame();
    const result = await runConsoleScript(target(game), CONSOLE_FILE);
    expect(result).toMatchObject({ ok: true, executed: 12 });
    expect(result.output).toEqual([HASH]);
    const world = game.world();
    expect(world.entities.find((e) => e.id === 3)?.pluggedInto).toStrictEqual({ entity: 1, outlet: 'bottom' });
    expect(world.entities.find((e) => e.id === 2)?.pluggedInto).toBeNull();
    expect(world.connections.find((c) => c.id === 1)?.marking).toStrictEqual({ a: null, b: 'red' });
    expect(world.entities.find((e) => e.id === 4)?.state).toMatchObject({
      directory1: 'BATH',
      directory3: null,
      directory4: 'null', // a quoted "null" is the text
    });
    expect(world.entities.find((e) => e.id === 6)?.state).toMatchObject({ test: 2, reset: 0 });
  });

  it('the TypeScript script reaches the same hash, and its log replays as console lines', async () => {
    const game = benchGame();
    script(game);
    expect(game.hash()).toBe(HASH);
    const again = benchGame();
    expect(await runConsoleScript(target(again), toConsoleScript(game.entries()))).toMatchObject({ ok: true });
    expect(again.hash()).toBe(HASH);
  });

  it('a refused line stops the file with its code', async () => {
    const game = benchGame();
    const result = await runConsoleScript(target(game), 'plug.insert 2 4 top\n');
    expect(result).toMatchObject({ ok: false, executed: 0, error: { kind: 'exec', lineNumber: 1 } });
    expect(JSON.stringify(result)).toContain('not-a-receptacle');
    const momentary = await runConsoleScript(target(game), 'device.operate 6 test 1\n');
    expect(JSON.stringify(momentary)).toContain('momentary');
  });
});

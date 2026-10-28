import {
  createManifest,
  createReplayLog,
  createWorld,
  migrateReplayLog,
  readCtrl,
  writeCtrl,
} from '@controls/save-format';
import { rawZip } from '@controls/save-format/testing';
import { createGame, replayGame } from '@controls/scripting-api';
import { hashWorldDocument, loadLevel, newGameWorld, worldHash } from '@controls/world-model';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CliIo, EXIT_FAILURE, EXIT_OK, EXIT_USAGE, runCli, USAGE } from './cli';
import { documentKind, readDocument } from './documents';
import { domainAliases, isAllowedImport, isLibraryImporter, WORKSPACE_ROOT } from './script-loader';
import { WORKSHOP_LEVEL_PATH } from './testing/workshop';

const fixtures = join(WORKSPACE_ROOT, 'libs/domain/save-format/fixtures/v1');
const worldFixture = join(fixtures, 'world/props-and-extensions.json');
const replayFixture = join(fixtures, 'replay-log/place-move-delete-undo.json');

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sim-cli-spec-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function sim(...argv: string[]): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = { cwd: dir, stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) };
  const code = await runCli(argv, io);
  return { code, stdout, stderr };
}

async function file(name: string, content: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, content);
  return path;
}

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

describe('sim help and usage', () => {
  it.each([[], ['help'], ['--help'], ['-h']])('prints usage for %j', async (...argv) => {
    expect(await sim(...argv)).toEqual({ code: EXIT_OK, stdout: [USAGE], stderr: [] });
  });

  it.each([
    [['nope'], 'Unknown command "nope"'],
    [['hash'], '"hash" takes exactly one file'],
    [['hash', 'a', 'b'], '"hash" takes exactly one file'],
    [['hash', 'a', '--seed', '1'], 'Unknown option --seed for "hash"'],
    [['run', 'a', '--seed'], '--seed needs a value'],
    [['run', 'a', '--seed', '1', '--seed', '2'], '--seed is given twice'],
    [['run', 'a.console', '--seed', 'x'], '--seed must be an unsigned 32-bit integer'],
    [['run', 'a.console', '--seed', '4294967296'], '--seed must be an unsigned 32-bit integer'],
  ])('exits 2 for %j', async (argv, message) => {
    const result = await sim(...argv);
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toEqual([`sim: ${message}`, 'Run "sim help" for usage.']);
  });
});

describe('sim hash', () => {
  it('prints world.hash of a world document', async () => {
    const expected = hashWorldDocument(await json(worldFixture));
    if (!expected.ok) throw new Error('fixture should load');
    expect(await sim('hash', worldFixture)).toEqual({ code: EXIT_OK, stdout: [expected.hash], stderr: [] });
    expect((await sim('hash', worldFixture, '--expect', expected.hash)).code).toBe(EXIT_OK);
  });

  it('fails on a hash mismatch, still printing the hash', async () => {
    const result = await sim('hash', worldFixture, '--expect', 'abc');
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stdout).toHaveLength(1);
    expect(result.stderr).toEqual(['sim: hash mismatch: expected abc']);
  });

  it.each([
    ['missing.json', 'sim: missing.json: ENOENT'],
    ['save.ctrl', 'sim: save.ctrl: ENOENT'],
    ['.', 'sim: .: not a file'],
  ])('reports %s', async (name, message) => {
    expect(await sim('hash', name)).toEqual({ code: EXIT_FAILURE, stdout: [], stderr: [message] });
  });

  it('reports invalid JSON, invalid worlds and replay logs', async () => {
    await file('broken.json', '{ nope');
    expect((await sim('hash', 'broken.json')).stderr).toEqual(['sim: broken.json: not valid JSON']);
    await file('bad-world.json', JSON.stringify({ schemaVersion: 1, seed: 'x' }));
    expect((await sim('hash', 'bad-world.json')).stderr[0]).toMatch(/^sim: bad-world.json: /);
    expect((await sim('hash', replayFixture)).stderr).toEqual([
      `sim: ${replayFixture}: is a replay log (use "sim replay")`,
    ]);
  });
});

describe('sim replay', () => {
  it('replays a replay-log fixture and prints the live hash', async () => {
    const replayed = replayGame(await json(replayFixture));
    if (!replayed.ok) throw new Error('fixture should replay');
    expect(await sim('replay', replayFixture, '--expect', replayed.game.hash())).toEqual({
      code: EXIT_OK,
      stdout: [replayed.game.hash()],
      stderr: [],
    });
  });

  it('refuses world documents and logs that fail to load or replay', async () => {
    expect((await sim('replay', worldFixture)).stderr).toEqual([
      `sim: ${worldFixture}: is a world document, not a replay log (use "sim hash")`,
    ]);
    await file('future.log', JSON.stringify({ schemaVersion: 99, initialWorld: {}, entries: [] }));
    const future = await sim('replay', 'future.log');
    expect(future.code).toBe(EXIT_FAILURE);
    expect(future.stderr[0]).toMatch(/^sim: future.log: .*newer/i);

    const log = (await json(replayFixture)) as { entries: { id: string; args: object }[] };
    log.entries[1].args = { id: 5, positionMm: { x: 0, y: 0, z: 0 } };
    await file('diverged.json', JSON.stringify(log));
    expect((await sim('replay', 'diverged.json')).stderr[0]).toMatch(/^sim: diverged.json: Entry 1 \(entity.move\)/);
    expect((await sim('replay', 'missing.json')).stderr).toEqual(['sim: missing.json: ENOENT']);
  });
});

describe('sim run', () => {
  const placeLine =
    'entity.place --ref.id prop.crate --ref.version 1 --positionMm.x 1 --positionMm.y 2 --positionMm.z 3';

  it('runs a console-line file, printing world.hash queries and the final hash, and writes the log', async () => {
    await file('scenario.console', `# comment\n${placeLine}\nworld.hash\nedit.undo\n`);
    const result = await sim('run', 'scenario.console', '--seed', '5', '--log', 'out.json');
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toHaveLength(2);
    const log = migrateReplayLog(await json(join(dir, 'out.json')));
    if (!log.ok) throw new Error('the written log should load');
    expect(log.value.initialWorld.seed).toBe(5);
    expect(log.value.entries.map((e) => e.id)).toEqual(['entity.place', 'edit.undo']);
    // Replaying the written log gives the run's final hash.
    expect((await sim('replay', 'out.json')).stdout).toEqual([result.stdout[1]]);
  });

  it('reports console-line errors with line and column', async () => {
    await file('typo.console', `${placeLine}\nentity.delete --idd 1\n`);
    expect(await sim('run', 'typo.console')).toEqual({
      code: EXIT_FAILURE,
      stdout: [],
      stderr: ['sim: typo.console: line 2, column 15: Unknown argument --idd'],
    });
    await file('fails.console', `world.hash\n${placeLine}\nentity.delete 9\n`);
    const fails = await sim('run', 'fails.console');
    expect(fails.code).toBe(EXIT_FAILURE);
    expect(fails.stdout).toHaveLength(1); // the world.hash before the failure
    expect(fails.stderr).toEqual(['sim: fails.console: line 3, column 1: No entity with id 9']);
    expect((await sim('run', 'nothing.console')).stderr).toEqual(['sim: nothing.console: ENOENT']);
  });

  it('starts from --world', async () => {
    const result = await sim('run', await file('noop.console', ''), '--world', worldFixture);
    const expected = hashWorldDocument(await json(worldFixture));
    expect(expected.ok && result.stdout).toEqual([expected.ok && expected.hash]);
    expect((await sim('run', 'noop.console', '--world', replayFixture)).stderr).toEqual([
      `sim: ${replayFixture}: is a replay log, not a world document`,
    ]);
    expect((await sim('run', 'noop.console', '--world', 'gone.json')).stderr).toEqual(['sim: gone.json: ENOENT']);
    await file('bad-world.json', JSON.stringify({ schemaVersion: 1 }));
    expect((await sim('run', 'noop.console', '--world', 'bad-world.json')).stderr[0]).toMatch(/^sim: bad-world.json: /);
  });

  it('--world with --seed starts a new game on that level (New sandbox), and validates the seed first', async () => {
    const level = await json(WORKSHOP_LEVEL_PATH);
    const loaded = loadLevel(level);
    if (!loaded.ok) throw new Error('workshop should load');
    const expected = worldHash(newGameWorld(loaded.level, { seed: 42 }));
    const result = await sim('run', await file('noop.console', ''), '--world', WORKSHOP_LEVEL_PATH, '--seed', '42');
    expect(result).toEqual({ code: EXIT_OK, stdout: [expected], stderr: [] });
    // Without --seed the level runs as it is (seed 0).
    const plain = await sim('run', 'noop.console', '--world', WORKSHOP_LEVEL_PATH);
    expect(plain.stdout).toEqual([worldHash(loaded.level)]);
    expect((await sim('run', 'noop.console', '--world', WORKSHOP_LEVEL_PATH, '--seed', '-1')).code).toBe(EXIT_USAGE);
  });

  it('runs a TypeScript module script against the game', async () => {
    await file(
      'script.ts',
      `import type { Game } from '@controls/scripting-api';
       import { formatConsoleLine } from '@controls/commands';
       export default async (game: Game): Promise<void> => {
         game.execOrThrow('entity.place', { ref: { id: 'prop.box', version: 1 }, positionMm: { x: 0, y: 0, z: 0 } });
         if (formatConsoleLine('edit.undo') !== 'edit.undo') throw new Error('runtime import failed');
         await Promise.resolve();
       };`,
    );
    const result = await sim('run', 'script.ts', '--seed', '3');
    expect(result.stderr).toEqual([]);
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toHaveLength(1);
  });

  it('lets a script save (fflate comes in through save-format) but not import fflate itself', async () => {
    await file(
      'saver.ts',
      `import type { Game } from '@controls/scripting-api';
       import { readCtrl } from '@controls/save-format';
       export default (game: Game): void => {
         const read = readCtrl(game.save());
         if (!read.ok) throw new Error(read.error.message);
       };`,
    );
    expect(await sim('run', 'saver.ts')).toMatchObject({ code: EXIT_OK, stderr: [] });
    await file('zip.ts', "import { zipSync } from 'fflate';\nexport default () => zipSync;");
    expect((await sim('run', 'zip.ts')).stderr[0]).toMatch(/not "fflate"/);
    expect(isLibraryImporter(join(WORKSPACE_ROOT, 'libs/domain/save-format/src/lib/container/zip.ts'))).toBe(true);
    expect(isLibraryImporter(join(WORKSPACE_ROOT, 'node_modules/zod/index.js'))).toBe(true);
    expect(isLibraryImporter(join(dir, 'zip.ts'))).toBe(false);
    expect(isLibraryImporter(join(WORKSPACE_ROOT, 'libs/domain/save-format/src/testing/arbitraries.ts'))).toBe(false);
    // So the test helpers still can't be bundled into a script (they need fast-check).
    await file(
      'helpers.ts',
      "import { TINY_PNG } from '@controls/save-format/testing';\nexport default () => TINY_PNG;",
    );
    expect((await sim('run', 'helpers.ts')).stderr[0]).toMatch(/not "fast-check"/);
  });

  it('reports script problems: compile errors, banned imports, no default export, throws', async () => {
    await file('syntax.ts', 'export default (game => {');
    expect((await sim('run', 'syntax.ts')).stderr[0]).toMatch(/^sim: syntax.ts:1:\d+: /);

    await file('fs.ts', "import { readFileSync } from 'node:fs';\nexport default () => readFileSync;");
    expect((await sim('run', 'fs.ts')).stderr[0]).toMatch(/Scripts may import only .* not "node:fs"/);
    await file('ui.ts', "import { Session } from '@controls/feature-session';\nexport default () => Session;");
    expect((await sim('run', 'ui.ts')).stderr[0]).toMatch(/not "@controls\/feature-session"/);

    await file('named.mjs', 'export const run = () => 1;');
    expect((await sim('run', 'named.mjs')).stderr).toEqual([
      'sim: named.mjs: the script must export a default function (game) => …',
    ]);
    await file('top.ts', "throw new Error('at load');\nexport default () => 1;");
    expect((await sim('run', 'top.ts')).stderr[0]).toMatch(/^sim: top.ts: the script threw while loading: .*at load/);
    await file('throws.ts', "export default () => { throw new TypeError('boom'); };");
    expect((await sim('run', 'throws.ts')).stderr).toEqual(['sim: throws.ts: script failed: TypeError: boom']);
    await file('throws-value.ts', "export default () => { throw 'plain'; };");
    expect((await sim('run', 'throws-value.ts')).stderr).toEqual(['sim: throws-value.ts: script failed: plain']);
  });
});

describe('.ctrl saves (F1.8b)', () => {
  const ctrlFixture = join(fixtures, 'ctrl/place-move-delete-undo.ctrl');
  const worldOnly = join(fixtures, 'ctrl/world-only.ctrl');
  const crate = { id: 'prop.crate', version: 1 };

  async function saveFile(name: string, bytes: Uint8Array): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, bytes);
    return path;
  }

  it('hash prints the hash of the save’s world.json; replay replays its log to the same hash', async () => {
    const read = readCtrl(new Uint8Array(await readFile(ctrlFixture)));
    if (!read.ok) throw new Error('fixture should load');
    const expected = worldHash(read.value.world);
    expect(await sim('hash', ctrlFixture)).toEqual({ code: EXIT_OK, stdout: [expected], stderr: [] });
    expect(await sim('replay', ctrlFixture, '--expect', expected)).toEqual({
      code: EXIT_OK,
      stdout: [expected],
      stderr: [],
    });
  });

  it('recognises a save by its ZIP signature whatever its extension', async () => {
    const renamed = await saveFile('save.bin', new Uint8Array(await readFile(worldOnly)));
    expect((await sim('hash', renamed)).code).toBe(EXIT_OK);
  });

  it('replay needs a replay.log that reproduces world.json', async () => {
    expect((await sim('replay', worldOnly)).stderr).toEqual([`sim: ${worldOnly}: has no replay.log (use "sim hash")`]);

    const world = createWorld({ seed: 1 });
    const other = createGame({ seed: 2 });
    other.execOrThrow('entity.place', { ref: crate, positionMm: { x: 0, y: 0, z: 0 } });
    const mismatched = await saveFile(
      'mismatched.ctrl',
      writeCtrl({ manifest: createManifest(), world, replayLog: other.replayLog() }),
    );
    const result = await sim('replay', mismatched);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toEqual([
      `sim: ${mismatched}: replay.log replays to ${other.hash()}, but world.json hashes to ${worldHash(world)}`,
    ]);

    const failing = await saveFile(
      'failing.ctrl',
      writeCtrl({
        manifest: createManifest(),
        world,
        replayLog: createReplayLog(world, [{ seq: 0, tick: 0, id: 'entity.delete', args: { id: 4 } }]),
      }),
    );
    expect((await sim('replay', failing)).stderr[0]).toMatch(
      /^sim: .*failing.ctrl: replay.log: Entry 0 \(entity.delete\)/,
    );
  });

  it('reports damaged, hostile and newer saves with the container’s message', async () => {
    const junk = await saveFile('junk.ctrl', new Uint8Array([1, 2, 3, 4]));
    expect((await sim('hash', junk)).stderr).toEqual([
      `sim: ${junk}: Not a valid ZIP archive: no end-of-central-directory record.`,
    ]);
    const traversal = await saveFile('evil.ctrl', rawZip([{ name: '../world.json', data: '{}' }]));
    expect((await sim('replay', traversal)).stderr[0]).toMatch(/unsafe path \(parent-directory segment\)/);
    const newer = await saveFile(
      'newer.ctrl',
      rawZip([{ name: 'manifest.json', data: JSON.stringify({ ...createManifest(), schemaVersion: 7 }) }]),
    );
    const refused = await sim('run', await file('noop.console', ''), '--world', newer);
    expect(refused.code).toBe(EXIT_FAILURE);
    expect(refused.stderr[0]).toMatch(/save format 7\). This build .* Update the game to open it\.$/);
  });

  it('run --world <save> loads it as the game does: undo cleared, the log continued', async () => {
    await file(
      'place.console',
      'entity.place --ref.id prop.box --ref.version 1 --positionMm.x 5 --positionMm.y 0 --positionMm.z 0\n',
    );
    const out = join(dir, 'continued.json');
    const result = await sim('run', 'place.console', '--world', ctrlFixture, '--log', out);
    expect(result.stderr).toEqual([]);
    const log = migrateReplayLog(await json(out));
    if (!log.ok) throw new Error('log should load');
    const saved = migrateReplayLog(await json(replayFixture));
    if (!saved.ok) throw new Error('fixture should load');
    expect(log.value.initialWorld).toStrictEqual(saved.value.initialWorld);
    expect(log.value.entries.map((e) => e.id)).toEqual([...saved.value.entries.map((e) => e.id), 'entity.place']);

    // Undo can't reach past the load.
    await file('undo.console', 'edit.undo\n');
    expect((await sim('run', 'undo.console', '--world', ctrlFixture)).stderr[0]).toMatch(/^sim: undo.console: line 1/);
  });

  it('run --world <save> warns when the save’s log has to restart', async () => {
    const other = createGame({ seed: 2 });
    const mismatched = await saveFile(
      'restart.ctrl',
      writeCtrl({ manifest: createManifest(), world: createWorld({ seed: 1 }), replayLog: other.replayLog() }),
    );
    const result = await sim('run', await file('noop.console', ''), '--world', mismatched);
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toEqual([worldHash(createWorld({ seed: 1 }))]);
    expect(result.stderr).toEqual([
      `sim: ${mismatched}: The save's replay log doesn't reproduce its world, so a new log starts from the loaded world.`,
    ]);
  });

  it('run --world <save> --seed N starts a new game on the saved world', async () => {
    const read = readCtrl(new Uint8Array(await readFile(worldOnly)));
    if (!read.ok) throw new Error('fixture should load');
    const result = await sim('run', await file('noop.console', ''), '--world', worldOnly, '--seed', '77');
    expect(result.stdout).toEqual([worldHash(newGameWorld(read.value.world, { seed: 77 }))]);
  });

  it('run --save writes a .ctrl that loads back to the same hash, byte-identical across runs', async () => {
    const run = async (name: string) => {
      const result = await sim('run', 'scenario.console', '--seed', '5', '--save', name);
      expect(result.code).toBe(EXIT_OK);
      return { hash: result.stdout.at(-1), bytes: new Uint8Array(await readFile(join(dir, name))) };
    };
    await file('scenario.console', `${placeLineFor(1)}\n${placeLineFor(2)}\nedit.undo\n`);
    const a = await run('a.ctrl');
    const b = await run('b.ctrl');
    expect(b.bytes).toStrictEqual(a.bytes);
    expect((await sim('replay', 'a.ctrl')).stdout).toEqual([a.hash]);
  });
});

function placeLineFor(x: number): string {
  return `entity.place --ref.id prop.crate --ref.version 1 --positionMm.x ${x} --positionMm.y 0 --positionMm.z 0`;
}

describe('documents', () => {
  it('classifies by content', () => {
    expect(documentKind({ initialWorld: {}, entries: [] })).toBe('replay-log');
    expect(documentKind({ schemaVersion: 1 })).toBe('world');
    expect(documentKind([])).toBe('world');
    expect(documentKind(null)).toBe('world');
  });

  it('caps the size it reads', async () => {
    const big = await file('big.json', ' ');
    const { MAX_DOCUMENT_BYTES } = await import('./documents');
    await writeFile(big, Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 0x20));
    expect(await readDocument(big, 'big.json')).toEqual({
      ok: false,
      message: `big.json: larger than ${MAX_DOCUMENT_BYTES} bytes`,
    });
  });
});

describe('script import boundary', () => {
  it('allows relative files, type:domain aliases and zod only', async () => {
    const aliases = await domainAliases();
    expect([...aliases].sort()).toEqual([
      '@controls/commands',
      '@controls/save-format',
      '@controls/save-format/testing',
      '@controls/scripting-api',
      '@controls/units',
      '@controls/world-model',
    ]);
    for (const ok of ['./x', '../y', '/abs/z', '@controls/world-model', 'zod', 'zod/v4']) {
      expect(isAllowedImport(ok, aliases)).toBe(true);
    }
    for (const banned of ['node:fs', 'fs', 'three', '@controls/renderer', '@controls/feature-session', 'esbuild']) {
      expect(isAllowedImport(banned, aliases)).toBe(false);
    }
  });
});

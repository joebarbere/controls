import { migrateReplayLog } from '@controls/save-format';
import { replayGame } from '@controls/scripting-api';
import { hashWorldDocument, loadLevel, newGameWorld, worldHash } from '@controls/world-model';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CliIo, EXIT_FAILURE, EXIT_OK, EXIT_USAGE, runCli, USAGE } from './cli';
import { documentKind, readDocument } from './documents';
import { domainAliases, isAllowedImport, WORKSPACE_ROOT } from './script-loader';
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
    [
      'save.ctrl',
      'sim: save.ctrl: .ctrl saves are not supported until F1.8b; pass the world or replay-log JSON instead',
    ],
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

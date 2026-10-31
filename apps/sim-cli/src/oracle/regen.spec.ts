import { ORACLE_CORPUS, oracleCorpus, oracleDeck, parseOracleResults } from '@controls/sim-core/oracle';
import { sha256Hex } from '@controls/world-model';
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CliIo, EXIT_FAILURE, EXIT_OK, EXIT_USAGE, runCli } from '../cli';
import { defaultNgspiceBinary, type NgspiceRun, type NgspiceRunner, spawnNgspice } from './regen';

/*
 * `sim oracle regen` (F2.7) against a fake ngspice: it answers `-v` with a banner and `-b <deck>`
 * with a value for every vector the deck prints, so the whole pipeline (decks, runs, parsing, results
 * files) is exercised without ngspice installed. Real ngspice is never run in `pnpm verify` (D5).
 */

const BANNER = '******\n** ngspice-47 : Circuit level simulation program\n** Compiled with KLU Direct Linear Solver\n';

/** A fake ngspice: `-v` prints the banner; `-b deck` prints `name = value` for each printed vector. */
function fakeNgspice(overrides: { solver?: string; batch?: (deck: string) => NgspiceRun | null } = {}): NgspiceRunner {
  return async (args) => {
    if (args[0] === '-v') return { status: 0, stdout: BANNER, stderr: '' };
    const deck = await readFile(args[1], 'utf8');
    const custom = overrides.batch?.(deck);
    if (custom) return custom;
    const ac = deck.includes('\nac lin ');
    const names = deck
      .split('\n')
      .filter((line) => line.startsWith('print '))
      .flatMap((line) => line.slice(6).split(' '));
    const values = names.map((name, k) => `${name} = ${ac ? `${k}.5e-01,-${k}e+00` : `${k}.25e+00`}`);
    return {
      status: 0,
      stdout: `Using ${overrides.solver ?? 'SPARSE 1.3'} as Direct Linear Solver\nNo. of Data Rows : 1\n${values.join('\n')}\n`,
      stderr: '',
    };
  };
}

async function sim(io: Partial<CliIo>, ...argv: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(argv, {
    cwd: tmpdir(),
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    ...io,
  });
  return { code, stdout, stderr };
}

let out: string;
beforeEach(async () => {
  out = await mkdtemp(join(tmpdir(), 'controls-oracle-'));
});
afterEach(async () => {
  await rm(out, { recursive: true, force: true });
});

describe('sim oracle regen', () => {
  it('writes every deck and both results files from ngspice output, and summarises', async () => {
    // A stray deck from a larger corpus is removed; other files are left alone.
    await mkdir(join(out, 'dc'), { recursive: true });
    await writeFile(join(out, 'dc/dc-9999.cir'), 'stale');
    await writeFile(join(out, 'dc/notes.txt'), 'keep');
    const run = await sim({ ngspice: fakeNgspice() }, 'oracle', 'regen', '--out', out);
    expect(run.stderr).toEqual([]);
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toEqual([
      `dc ${ORACLE_CORPUS.dc.count} circuits, ngspice-47, SPARSE 1.3`,
      `ac ${ORACLE_CORPUS.ac.count} circuits, ngspice-47, SPARSE 1.3`,
    ]);
    const dcFiles = (await readdir(join(out, 'dc'))).sort();
    expect(dcFiles).toHaveLength(ORACLE_CORPUS.dc.count + 1);
    expect(dcFiles).toContain('notes.txt');
    expect(dcFiles).not.toContain('dc-9999.cir');

    const circuit = oracleCorpus('ac')[5];
    const deck = oracleDeck(circuit);
    expect(await readFile(join(out, 'ac', `${circuit.name}.cir`), 'utf8')).toBe(deck);
    const results = parseOracleResults(await readFile(join(out, 'ac.results.txt'), 'utf8'));
    expect(results.header).toMatchObject({ domain: 'ac', ngspice: 'ngspice-47', solver: 'SPARSE 1.3' });
    expect(results.circuits[5]).toMatchObject({ name: circuit.name, deckSha256: sha256Hex(deck) });
    // The fake prints k.5e-01,-k for the k-th vector: node 1 is the first.
    expect(results.circuits[5].nodes.slice(0, 4)).toStrictEqual([0, 0, 0.05, -0]);
  });

  it('fails clearly, pointing at the install notes, when ngspice is missing', async () => {
    const run = await sim({}, 'oracle', 'regen', '--out', out, '--ngspice', join(out, 'no-such-ngspice'));
    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.stderr.join('\n')).toMatch(/ngspice not found .*docs\/guides\/oracle\.md/);
    expect(await readdir(out)).toEqual([]);
  });

  it('fails when the binary reports no version', async () => {
    const run = await sim(
      { ngspice: async () => ({ status: 0, stdout: 'hello', stderr: '' }) },
      'oracle',
      'regen',
      '--out',
      out,
    );
    expect(run.stderr).toEqual([
      `sim: oracle regen: "${defaultNgspiceBinary()} -v" did not report an ngspice version (exit 0)`,
    ]);
  });

  it('fails, writing no results, when a run fails or prints too little', async () => {
    const crash = fakeNgspice({
      batch: (deck) => (deck.includes('dc-0003') ? { status: 1, stdout: '', stderr: 'boom' } : null),
    });
    const crashed = await sim({ ngspice: crash }, 'oracle', 'regen', '--out', out);
    expect(crashed.code).toBe(EXIT_FAILURE);
    expect(crashed.stderr).toEqual(['sim: oracle regen: dc-0003: ngspice exited 1: boom']);
    expect(await readdir(out)).not.toContain('dc.results.txt');

    const terse = fakeNgspice({
      batch: () => ({ status: 0, stdout: 'Using SPARSE 1.3 as Direct Linear Solver\n', stderr: '' }),
    });
    expect((await sim({ ngspice: terse }, 'oracle', 'regen', '--out', out)).stderr[0]).toMatch(
      /^sim: oracle regen: dc-0000: ngspice printed no v\(1\)$/,
    );
  });

  it('fails when a binary vanishes mid-run', async () => {
    const vanish = fakeNgspice({ batch: () => ({ status: null, stdout: '', stderr: 'gone', missing: true }) });
    expect((await sim({ ngspice: vanish }, 'oracle', 'regen', '--out', out)).stderr[0]).toMatch(/ngspice not found/);
  });

  it('refuses results not solved by Sparse (".options sparse" ignored)', async () => {
    const run = await sim({ ngspice: fakeNgspice({ solver: 'KLU' }) }, 'oracle', 'regen', '--out', out);
    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.stderr[0]).toMatch(/ngspice used KLU, not Sparse/);
  });

  it('takes one subcommand', async () => {
    expect((await sim({}, 'oracle')).code).toBe(EXIT_USAGE);
    expect((await sim({}, 'oracle', 'run')).stderr[0]).toBe('sim: Unknown oracle subcommand "run" (expected "regen")');
    expect((await sim({}, 'oracle', 'regen', '--seed', '1')).code).toBe(EXIT_USAGE);
  });
});

describe('spawnNgspice', () => {
  it('runs a real process and captures its output and status', async () => {
    const node = spawnNgspice(process.execPath);
    expect(await node(['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)'])).toEqual({
      status: 3,
      stdout: 'out',
      stderr: 'err',
    });
  });

  it('marks a binary that does not exist as missing', async () => {
    expect(await spawnNgspice(join(tmpdir(), 'controls-no-such-binary'))(['-v'])).toMatchObject({ missing: true });
  });

  it('uses the console build on Windows', () => {
    expect(defaultNgspiceBinary('win32')).toBe('ngspice_con');
    expect(defaultNgspiceBinary('linux')).toBe('ngspice');
  });
});

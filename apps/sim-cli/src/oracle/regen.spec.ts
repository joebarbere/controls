import { generateOracleCircuit, ORACLE_CORPUS, oracleDeck, parseOracleResults } from '@controls/sim-core/oracle';
import { sha256Hex } from '@controls/world-model';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CliIo, EXIT_FAILURE, EXIT_OK, EXIT_USAGE, runCli } from '../cli';
import { defaultNgspiceBinary, type NgspiceRun, type NgspiceRunner, spawnNgspice } from './regen';

/*
 * `sim oracle regen` (F2.7) against a fake ngspice: it answers `-v` with a banner and `-n -b <deck>`
 * with a value for every vector the deck prints, so the whole pipeline (decks, runs, parsing, results
 * files, the swap into place) is exercised without ngspice installed. Real ngspice is never run in
 * `pnpm verify` (D5). The specs regenerate a small corpus (`oracleCounts`): writing all 1,000 decks
 * per test is slow on Windows CI.
 */

const BANNER = '******\n** ngspice-47 : Circuit level simulation program\n** Compiled with KLU Direct Linear Solver\n';
const COUNTS = { dc: 4, ac: 3 };

interface FakeOptions {
  readonly solver?: string;
  readonly batch?: (deck: string) => NgspiceRun | null;
  /** Every argument list the fake was called with. */
  readonly calls?: (readonly string[])[];
}

/** A fake ngspice: `-v` prints the banner; `-n -b deck` prints `name = value` for each printed vector. */
function fakeNgspice(options: FakeOptions = {}): NgspiceRunner {
  return async (args) => {
    options.calls?.push(args);
    if (args[0] === '-v') return { status: 0, stdout: BANNER, stderr: '' };
    const deck = await readFile(args[args.length - 1], 'utf8');
    const custom = options.batch?.(deck);
    if (custom) return custom;
    const ac = deck.includes('\nac lin ');
    const names = deck
      .split('\n')
      .filter((line) => line.startsWith('print '))
      .flatMap((line) => line.slice(6).split(' '));
    const values = names.map((name, k) => `${name} = ${ac ? `${k}.5e-01,-${k}e+00` : `${k}.25e+00`}`);
    return {
      status: 0,
      stdout: `Using ${options.solver ?? 'SPARSE 1.3'} as Direct Linear Solver\nNo. of Data Rows : 1\n${values.join('\n')}\n`,
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
    oracleCounts: COUNTS,
    ...io,
  });
  return { code, stdout, stderr };
}

const regen = (io: Partial<CliIo>) => sim(io, 'oracle', 'regen', '--out', out);

let out: string;
beforeEach(async () => {
  out = await mkdtemp(join(tmpdir(), 'controls-oracle-'));
});
afterEach(async () => {
  await rm(out, { recursive: true, force: true });
});

/** A previous corpus in `out`, to show a failed run leaves it alone and a good one replaces it. */
async function previousCorpus() {
  await mkdir(join(out, 'dc'), { recursive: true });
  await writeFile(join(out, 'dc/dc-9999.cir'), 'stale');
  await writeFile(join(out, 'dc.results.txt'), 'old results');
}

describe('sim oracle regen', () => {
  it('writes every deck and both results files from ngspice output, runs ngspice with -n, and summarises', async () => {
    await previousCorpus();
    const calls: (readonly string[])[] = [];
    const run = await regen({ ngspice: fakeNgspice({ calls }) });
    expect(run.stderr).toEqual([]);
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toEqual(['dc 4 circuits, ngspice-47, SPARSE 1.3', 'ac 3 circuits, ngspice-47, SPARSE 1.3']);
    // -n: never read a .spiceinit, which could change the results.
    expect(calls[0]).toEqual(['-v']);
    expect(calls).toHaveLength(1 + COUNTS.dc + COUNTS.ac);
    for (const args of calls.slice(1)) expect(args.slice(0, 2)).toEqual(['-n', '-b']);

    // The old corpus is replaced wholesale, and no staging directory is left.
    expect((await readdir(out)).sort()).toEqual(['ac', 'ac.results.txt', 'dc', 'dc.results.txt']);
    expect((await readdir(join(out, 'dc'))).sort()).toEqual([
      'dc-0000.cir',
      'dc-0001.cir',
      'dc-0002.cir',
      'dc-0003.cir',
    ]);

    const circuit = generateOracleCircuit('ac', ORACLE_CORPUS.ac.seed, 2);
    const deck = oracleDeck(circuit);
    expect(await readFile(join(out, 'ac', `${circuit.name}.cir`), 'utf8')).toBe(deck);
    const results = parseOracleResults(await readFile(join(out, 'ac.results.txt'), 'utf8'));
    expect(results.header).toMatchObject({ domain: 'ac', ngspice: 'ngspice-47', solver: 'SPARSE 1.3', count: 3 });
    expect(results.circuits[2]).toMatchObject({ name: circuit.name, deckSha256: sha256Hex(deck) });
    // The fake prints k.5e-01,-k for the k-th vector: node 1 is the first.
    expect(results.circuits[2].nodes.slice(0, 4)).toStrictEqual([0, 0, 0.05, -0]);
  });

  it('fails clearly, pointing at the install notes, when ngspice is missing', async () => {
    const run = await sim({}, 'oracle', 'regen', '--out', out, '--ngspice', join(out, 'no-such-ngspice'));
    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.stderr.join('\n')).toMatch(/ngspice not found .*docs\/guides\/oracle\.md/);
    expect(await readdir(out)).toEqual([]);
  });

  it('fails when the binary reports no version', async () => {
    const run = await regen({ ngspice: async () => ({ status: 0, stdout: 'hello', stderr: '' }) });
    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.stderr).toEqual([
      `sim: oracle regen: "${defaultNgspiceBinary()} -v" did not report an ngspice version (exit 0)`,
    ]);
  });

  it('on a failed run, leaves the previous corpus untouched and starts no more ngspice runs', async () => {
    await previousCorpus();
    const calls: (readonly string[])[] = [];
    const crash = fakeNgspice({
      calls,
      batch: (deck) => (deck.includes('dc-0001') ? { status: 1, stdout: '', stderr: 'boom' } : null),
    });
    const crashed = await sim(
      { ngspice: crash, oracleCounts: { dc: 20, ac: 3 } },
      'oracle',
      'regen',
      '--out',
      out,
      '--jobs',
      '2',
    );
    expect(crashed.code).toBe(EXIT_FAILURE);
    expect(crashed.stderr).toEqual(['sim: oracle regen: dc-0001: ngspice exited 1: boom']);
    expect((await readdir(out)).sort()).toEqual(['dc', 'dc.results.txt']);
    expect(await readdir(join(out, 'dc'))).toEqual(['dc-9999.cir']);
    expect(await readFile(join(out, 'dc.results.txt'), 'utf8')).toBe('old results');
    // -v, dc-0000 and dc-0001, and at most one more run per worker: never the rest of the corpus.
    expect(calls.length).toBeLessThanOrEqual(1 + 2 + 2);
  });

  it('reports the first failure in corpus order, whichever run finishes first', async () => {
    // dc-0001 fails at once; dc-0000 fails only after it, so finishing order and corpus order disagree.
    let laterFailed: () => void = () => undefined;
    const later = new Promise<void>((resolve) => (laterFailed = resolve));
    const racing: NgspiceRunner = async (args) => {
      if (args[0] === '-v') return { status: 0, stdout: BANNER, stderr: '' };
      const deck = args[args.length - 1];
      if (deck.endsWith('dc-0001.cir')) {
        laterFailed();
        return { status: 1, stdout: '', stderr: 'second' };
      }
      await later;
      return { status: 1, stdout: '', stderr: 'first' };
    };
    const run = await sim({ ngspice: racing }, 'oracle', 'regen', '--out', out, '--jobs', '2');
    expect(run.stderr).toEqual(['sim: oracle regen: dc-0000: ngspice exited 1: first']);
  });

  it('fails when a run prints too little, times out, or the binary vanishes', async () => {
    const terse = fakeNgspice({
      batch: () => ({ status: 0, stdout: 'Using SPARSE 1.3 as Direct Linear Solver\n', stderr: '' }),
    });
    expect((await regen({ ngspice: terse })).stderr).toEqual(['sim: oracle regen: dc-0000: ngspice printed no v(1)']);
    const slow = fakeNgspice({ batch: () => ({ status: null, stdout: '', stderr: '', timedOut: true }) });
    expect((await regen({ ngspice: slow })).stderr).toEqual(['sim: oracle regen: dc-0000: ngspice timed out']);
    const vanish = fakeNgspice({ batch: () => ({ status: null, stdout: '', stderr: 'gone', missing: true }) });
    expect((await regen({ ngspice: vanish })).stderr[0]).toMatch(/ngspice not found/);
  });

  it('refuses results not solved by Sparse (".options sparse" ignored)', async () => {
    const run = await regen({ ngspice: fakeNgspice({ solver: 'KLU' }) });
    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.stderr[0]).toMatch(/ngspice used KLU, not Sparse/);
    expect(await readdir(out)).toEqual([]);
  });

  it('takes one subcommand', async () => {
    expect((await sim({}, 'oracle')).code).toBe(EXIT_USAGE);
    expect((await sim({}, 'oracle', 'run')).stderr[0]).toBe('sim: Unknown oracle subcommand "run" (expected "regen")');
    expect((await sim({}, 'oracle', 'regen', '--seed', '1')).code).toBe(EXIT_USAGE);
    expect((await sim({}, 'oracle', 'regen', '--jobs', '0')).stderr[0]).toBe(
      'sim: --jobs must be a whole number from 1 to 9999',
    );
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

  it('kills a run that outlives its timeout', async () => {
    const node = spawnNgspice(process.execPath, 200);
    expect(await node(['-e', 'setInterval(() => {}, 1000)'])).toMatchObject({ status: null, timedOut: true });
  });

  it('marks a binary that does not exist as missing', async () => {
    expect(await spawnNgspice(join(tmpdir(), 'controls-no-such-binary'))(['-v'])).toMatchObject({ missing: true });
  });

  it('uses the console build on Windows', () => {
    expect(defaultNgspiceBinary('win32')).toBe('ngspice_con');
    expect(defaultNgspiceBinary('linux')).toBe('ngspice');
  });
});

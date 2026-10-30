import { ESLint } from 'eslint';
import { join } from 'node:path';
import { WORKSPACE_ROOT } from './script-loader';

/*
 * The path-scoped determinism rules in the root eslint.config.mjs, proven to fire by linting probe
 * files with the real config (as lint-boundary.spec.ts does for the module boundaries). Loosening a
 * rule, or moving the exempt paths, fails `pnpm verify`:
 *
 * - the determinism lint (no Math.random, wall clock or crypto) over libs/domain, libs/sim-worker
 *   except src/lib/pacing/, and apps/sim-cli except src/bench/clock.ts (P2 kickoff step 6);
 * - D6 (plans/phase-2-circuit-engine.md; ADR 0014, to be written in F2.1): no engine-dependent
 *   Math functions or `**` in sim-core source;
 * - no Node built-ins in domain or sim-worker source.
 */

const RULES = new Set([
  'no-restricted-properties',
  'no-restricted-globals',
  'no-restricted-syntax',
  'no-restricted-imports',
]);

const eslint = new ESLint({ cwd: WORKSPACE_ROOT });

/** ESLint's own prefix before a configured message ("'Date.now' is restricted from being used. …"). */
const ESLINT_PREFIX =
  /^(?:'[^']+' (?:import )?is restricted from being used(?: by a pattern)?|Unexpected use of '[^']+')\. /;

/**
 * `ruleId: first sentence of the configured message` for every restricted-* error the real config
 * reports on `source` at `file`. A default ESLint message (no configured one) would not match.
 */
async function restrictions(source: string, file: string): Promise<string[]> {
  const [result] = await eslint.lintText(source, { filePath: join(WORKSPACE_ROOT, file) });
  return result.messages
    .filter((m) => m.ruleId !== null && RULES.has(m.ruleId))
    .map((m) => `${m.ruleId}: ${m.message.replace(ESLINT_PREFIX, '').split('. ')[0]}`);
}

const SIM_CORE_SOURCE = 'libs/domain/sim-core/src/lib/probe.ts';
const SIM_CORE_SPEC = 'libs/domain/sim-core/src/lib/probe.spec.ts';
const WORKER_SOURCE = 'libs/sim-worker/src/lib/probe.ts';
const WORKER_PACING = 'libs/sim-worker/src/lib/pacing/probe.ts';
const WORKER_PACING_NESTED = 'libs/sim-worker/src/lib/pacing/clock/probe.ts';

const WALL_CLOCK = [
  'export const a = Date.now();',
  'export const b = performance.now();',
  'export const c = new Date();',
  'export const d = Math.random();',
  'export const e = crypto.randomUUID();',
].join('\n');

const WALL_CLOCK_ERRORS = [
  'no-restricted-properties: Date.now() is banned in domain code, sim-worker and sim-cli',
  'no-restricted-globals: performance (performance.now() etc.) is banned in domain code, sim-worker and sim-cli',
  'no-restricted-syntax: new Date() is banned in domain code, sim-worker and sim-cli',
  'no-restricted-properties: Math.random() is banned in domain code, sim-worker and sim-cli',
  'no-restricted-globals: crypto (randomUUID, getRandomValues) is banned in domain code, sim-worker and sim-cli',
];

describe('D6: engine-dependent maths in sim-core', () => {
  const D6_FUNCTIONS = [
    'exp',
    'expm1',
    'log',
    'log1p',
    'log2',
    'log10',
    'pow',
    'sin',
    'cos',
    'tan',
    'asin',
    'acos',
    'atan',
    'atan2',
    'sinh',
    'cosh',
    'tanh',
    'asinh',
    'acosh',
    'atanh',
    'hypot',
    'cbrt',
  ];

  it.each(D6_FUNCTIONS)('rejects Math.%s in sim-core source', async (fn) => {
    expect(await restrictions(`export const x = Math.${fn}(0.5, 0.5);`, SIM_CORE_SOURCE)).toEqual([
      `no-restricted-properties: Math.${fn}() is engine-dependent and banned in sim-core source`,
    ]);
  });

  it('rejects the ** and **= operators in sim-core source', async () => {
    const source = 'export let x = 2 ** 0.5;\nx **= 3;';
    expect(await restrictions(source, SIM_CORE_SOURCE)).toEqual([
      'no-restricted-syntax: The ** operator is engine-dependent (it is Math.pow) and banned in sim-core source',
      'no-restricted-syntax: The **= operator is engine-dependent (it is Math.pow) and banned in sim-core source',
    ]);
  });

  it('rejects destructuring and computed access, which would bypass the member check', async () => {
    const source = "const { exp } = Math;\nexport const x = [exp(1), Math['log'](2)];";
    expect(await restrictions(source, SIM_CORE_SOURCE)).toEqual([
      'no-restricted-properties: Math.exp() is engine-dependent and banned in sim-core source',
      'no-restricted-properties: Math.log() is engine-dependent and banned in sim-core source',
    ]);
  });

  it('allows the IEEE-exact operations: arithmetic, Math.sqrt, fround, abs, min/max, rounding', async () => {
    const source = [
      'export const x = Math.sqrt(2) * 3 + 1 / 7 - 0.5 % 0.25;',
      'export const y = [Math.fround(x), Math.abs(x), Math.min(x, 1), Math.max(x, 1), Math.floor(x), Math.trunc(x)];',
    ].join('\n');
    expect(await restrictions(source, SIM_CORE_SOURCE)).toEqual([]);
  });

  it('keeps the determinism lint in sim-core source (the D6 block merges with it, not replaces it)', async () => {
    expect(await restrictions(WALL_CLOCK, SIM_CORE_SOURCE)).toEqual(WALL_CLOCK_ERRORS);
  });

  it('exempts sim-core specs, so a test can compare dmath with Math', async () => {
    expect(await restrictions('export const x = [Math.exp(1), 2 ** 0.5];', SIM_CORE_SPEC)).toEqual([]);
  });

  it.each(['libs/domain/sim-protocol/src/lib/probe.ts', 'libs/domain/world-model/src/lib/probe.ts', WORKER_SOURCE])(
    'applies only to sim-core (not %s)',
    async (file) => {
      expect(await restrictions('export const x = [Math.exp(1), 2 ** 0.5];', file)).toEqual([]);
    },
  );
});

describe('determinism lint in libs/sim-worker', () => {
  it('rejects the wall clock and ambient randomness outside pacing', async () => {
    expect(await restrictions(WALL_CLOCK, WORKER_SOURCE)).toEqual(WALL_CLOCK_ERRORS);
  });

  it('rejects them in worker specs too (a test that reads the clock is flaky)', async () => {
    expect(await restrictions(WALL_CLOCK, 'libs/sim-worker/src/lib/probe.spec.ts')).toEqual(WALL_CLOCK_ERRORS);
  });

  it.each([WORKER_PACING, WORKER_PACING_NESTED])('allows the wall clock in the pacing module (%s)', async (file) => {
    expect(await restrictions(WALL_CLOCK, file)).toEqual([]);
  });

  it('rejects Node built-ins in worker source, but not in specs', async () => {
    const source = "import { readFileSync } from 'node:fs';\nexport const probe = readFileSync;";
    expect(await restrictions(source, WORKER_SOURCE)).toEqual([
      'no-restricted-imports: Node built-ins are banned in domain source: it must also run in the browser and the sim worker.',
    ]);
    expect(await restrictions(source, 'libs/sim-worker/src/lib/probe.spec.ts')).toEqual([]);
  });
});

describe('determinism lint in apps/sim-cli', () => {
  it('rejects the wall clock in sim-cli source and scenarios', async () => {
    expect(await restrictions(WALL_CLOCK, 'apps/sim-cli/src/probe.ts')).toEqual(WALL_CLOCK_ERRORS);
    expect(await restrictions(WALL_CLOCK, 'apps/sim-cli/scenarios/probe.ts')).toEqual(WALL_CLOCK_ERRORS);
  });

  it('exempts only the bench clock file, not the rest of the bench', async () => {
    expect(await restrictions(WALL_CLOCK, 'apps/sim-cli/src/bench/clock.ts')).toEqual([]);
    expect(await restrictions(WALL_CLOCK, 'apps/sim-cli/src/bench/bench.ts')).toEqual(WALL_CLOCK_ERRORS);
  });
});

describe('determinism lint in libs/domain (P1, unchanged)', () => {
  it.each(['libs/domain/catalog/src/lib/probe.ts', 'libs/domain/sim-protocol/src/lib/probe.spec.ts'])(
    'still covers %s',
    async (file) => {
      expect(await restrictions(WALL_CLOCK, file)).toEqual(WALL_CLOCK_ERRORS);
    },
  );
});

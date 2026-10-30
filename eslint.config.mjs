import nx from '@nx/eslint-plugin';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * Framework, DOM and desktop packages that `type:domain` libs (and `scope:headless` apps) must never
 * import. Nx tag constraints only cover workspace libs, so npm packages need this list. A pattern
 * only fires once the package is installed (Nx matches against the project graph), so listing
 * planned UI dependencies (CodeMirror, dockview) here is harmless today and closes the gap the day
 * they are added.
 */
const frameworkPackages = [
  '@angular/*', // UI framework
  '@angular-devkit/*',
  'zone.js',
  'rxjs', // Angular's reactive runtime; domain code is synchronous and command-driven
  'rxjs/*',
  'electron', // desktop shell
  'electron/*',
  'electron-updater',
  'three', // rendering
  'three/*',
  'three-mesh-bvh',
  '@codemirror/*', // editor UI (P1 console)
  'codemirror',
  'dockview', // docking UI: not chosen in ADR 0005, kept banned in case it is revisited for editors
  'dockview-*',
  'jsdom', // DOM emulation would hide DOM coupling in tests
  '@playwright/test',
  'playwright',
];

/** Root of the domain libs. Absolute, because each project's ESLint config resolves globs from its own directory. */
const domainLibsDir = fileURLToPath(new URL('./libs/domain', import.meta.url));
/** apps/sim-cli and its scenario scripts: headless runs must be as deterministic as the domain they drive. */
const simCliDir = fileURLToPath(new URL('./apps/sim-cli', import.meta.url));
/** libs/sim-worker (P2, `type:worker`): runs sim-core in a Web Worker, so it is held to the domain rules. */
const simWorkerDir = fileURLToPath(new URL('./libs/sim-worker', import.meta.url));
/** libs/domain/sim-core (P2): its source is also held to the D6 deterministic-maths rule below. */
const simCoreDir = fileURLToPath(new URL('./libs/domain/sim-core', import.meta.url));

/** Every file pattern the path-scoped rules below apply to. */
const sourceFiles = ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts', '**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'];
/** Tooling configs, exempt from the path-scoped rules. */
const toolingConfigs = ['**/*.config.*', 'vitest.domain.mts'];
/** Specs and tests: they run only under Vitest in Node. */
const specFiles = ['**/*.spec.*', '**/*.test.*'];

const determinismHint =
  'Domain code must be deterministic: use the seeded PRNG in @controls/world-model and the integer sim tick (F1.2), never the wall clock or ambient randomness.';

/** Bans wall-clock time and ambient randomness (type:domain libs, sim-worker outside pacing, and sim-cli outside its bench clock). */
const determinismRules = {
  'no-restricted-properties': [
    'error',
    {
      object: 'Math',
      property: 'random',
      message: `Math.random() is banned in domain code, sim-worker and sim-cli. ${determinismHint}`,
    },
    {
      object: 'Date',
      property: 'now',
      message: `Date.now() is banned in domain code, sim-worker and sim-cli. ${determinismHint}`,
    },
    ...['performance', 'crypto', 'Date', 'Math'].map((property) => ({
      object: 'globalThis',
      property,
      message: `globalThis.${property} is banned in domain code, sim-worker and sim-cli (it bypasses the determinism lint). ${determinismHint}`,
    })),
  ],
  'no-restricted-globals': [
    'error',
    {
      name: 'performance',
      message: `performance (performance.now() etc.) is banned in domain code, sim-worker and sim-cli. ${determinismHint}`,
    },
    {
      name: 'crypto',
      message: `crypto (randomUUID, getRandomValues) is banned in domain code, sim-worker and sim-cli. Entity ids come from the world counter. ${determinismHint}`,
    },
  ],
  'no-restricted-syntax': [
    'error',
    {
      selector: "NewExpression[callee.name='Date']",
      message: `new Date() is banned in domain code, sim-worker and sim-cli. ${determinismHint}`,
    },
    {
      selector: "CallExpression[callee.name='Date']",
      message: `Date() is banned in domain code, sim-worker and sim-cli. ${determinismHint}`,
    },
  ],
};

/**
 * Decision D6 (plans/phase-2-circuit-engine.md; ADR 0014, to be written in F2.1): sim-core must give
 * byte-identical results in Node's V8 and Electron's Chromium V8. ECMAScript only requires these
 * functions to be "implementation-approximated", so engines may round them differently; `+ - * /`,
 * `Math.sqrt`, `Math.fround`, `Math.abs`, `Math.min/max`, `Math.floor/ceil/round/trunc` are exact.
 */
const d6EngineDependentMath = [
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
const d6Hint =
  'sim-core may use only IEEE-exact operations (+ - * /, Math.sqrt, …) and its own dmath, so a snapshot is byte-identical in Node and Chromium (decision D6 in plans/phase-2-circuit-engine.md; ADR 0014, to be written in F2.1).';

/** sim-core source: the determinism rules plus D6. Flat config replaces a rule's options wholesale, so the lists are merged. */
const simCoreRules = {
  ...determinismRules,
  'no-restricted-properties': [
    ...determinismRules['no-restricted-properties'],
    ...d6EngineDependentMath.map((property) => ({
      object: 'Math',
      property,
      message: `Math.${property}() is engine-dependent and banned in sim-core source. ${d6Hint}`,
    })),
  ],
  'no-restricted-syntax': [
    ...determinismRules['no-restricted-syntax'],
    {
      selector: "BinaryExpression[operator='**']",
      message: `The ** operator is engine-dependent (it is Math.pow) and banned in sim-core source. ${d6Hint}`,
    },
    {
      selector: "AssignmentExpression[operator='**=']",
      message: `The **= operator is engine-dependent (it is Math.pow) and banned in sim-core source. ${d6Hint}`,
    },
  ],
};

export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    ignores: ['**/dist', '**/out-tsc', '**/vitest.config.*.timestamp*'],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$'],
          // Layer rules — plan §4.2. domain/* stays framework-free so sim-cli can run headless.
          depConstraints: [
            {
              sourceTag: 'type:domain',
              onlyDependOnLibsWithTags: ['type:domain'],
              bannedExternalImports: frameworkPackages,
            },
            // libs/sim-worker (P2): the worker entry and pacing. Domain libs only (sim-core, sim-protocol, catalog),
            // with domain's banned npm imports. No other lib tag lists type:worker, so only apps can depend on
            // it; the renderer and features read snapshot types from @controls/sim-protocol (type:domain).
            {
              sourceTag: 'type:worker',
              onlyDependOnLibsWithTags: ['type:domain'],
              bannedExternalImports: frameworkPackages,
            },
            { sourceTag: 'type:contract', onlyDependOnLibsWithTags: ['type:contract', 'type:domain'] },
            { sourceTag: 'type:rendering', onlyDependOnLibsWithTags: ['type:rendering', 'type:domain'] },
            { sourceTag: 'type:platform', onlyDependOnLibsWithTags: ['type:platform', 'type:contract', 'type:domain'] },
            { sourceTag: 'type:ui', onlyDependOnLibsWithTags: ['type:ui', 'type:domain'] },
            {
              sourceTag: 'type:feature',
              onlyDependOnLibsWithTags: [
                'type:feature',
                'type:ui',
                'type:rendering',
                'type:domain',
                'type:contract',
                'type:platform',
              ],
            },
            { sourceTag: 'type:app', onlyDependOnLibsWithTags: ['*'] },
            { sourceTag: 'type:e2e', onlyDependOnLibsWithTags: [] },
            // content/ (F1.9): data only (levels now; the catalogue, tables and jobs later). It imports
            // nothing; apps bundle it (`@controls/content/levels/workshop.json`), headless tools read the files.
            { sourceTag: 'type:content', onlyDependOnLibsWithTags: [] },
            // apps/sim-cli (P1): runs the game in plain Node, so it may use domain libs only. All matching
            // constraints apply, so this narrows `type:app`'s wildcard. Precedent: the `scope:desktop` tag.
            {
              sourceTag: 'scope:headless',
              onlyDependOnLibsWithTags: ['type:domain'],
              bannedExternalImports: frameworkPackages,
            },
          ],
        },
      ],
    },
  },
  // Domain determinism (plan §4.6, phase-1 "Determinism and invariant hooks"). Applies to specs too:
  // a domain test that reads the clock or Math.random is a flaky test. Tooling configs are exempt.
  // sim-cli (F1.6) gets the same rules: a scenario script that reads the clock can't be re-run to the same hash.
  // Its bench clock (P2) is the one exemption: `sim bench` measures wall time, and nothing it times is hashed.
  // sim-worker (P2) too, except its pacing module, which turns wall time into tick targets (ADR 0011).
  ...[
    { basePath: domainLibsDir, ignores: [] },
    { basePath: simCliDir, ignores: ['src/bench/clock.ts'] },
    { basePath: simWorkerDir, ignores: ['src/lib/pacing/**'] },
  ].map(({ basePath, ignores }) => ({
    basePath,
    files: sourceFiles,
    ignores: [...toolingConfigs, ...ignores],
    rules: determinismRules,
  })),
  // D6 deterministic maths, sim-core source only (after the block above, which it extends). Specs are exempt
  // so they can compare dmath against Math; they run only in Node, so their rounding never reaches a hash.
  {
    basePath: simCoreDir,
    files: sourceFiles,
    ignores: [...toolingConfigs, ...specFiles],
    rules: simCoreRules,
  },
  // Domain source runs in the renderer and the sim worker as well as Node, so no Node built-ins; the
  // worker's own source neither. Specs run only under Vitest in Node and may use them (e.g. node:fs).
  ...[domainLibsDir, simWorkerDir].map((basePath) => ({
    basePath,
    files: sourceFiles,
    ignores: [...toolingConfigs, ...specFiles],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: builtinModules.map((name) => ({
            name,
            message: 'Node built-ins are banned in domain source: it must also run in the browser and the sim worker.',
          })),
          patterns: [
            {
              group: ['node:*'],
              message:
                'Node built-ins are banned in domain source: it must also run in the browser and the sim worker.',
            },
          ],
        },
      ],
    },
  })),
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.cts', '**/*.mts', '**/*.js', '**/*.jsx', '**/*.cjs', '**/*.mjs'],
    // Override or add rules here
    rules: {},
  },
];

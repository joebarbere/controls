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

const determinismHint =
  'Domain code must be deterministic: use the seeded PRNG in @controls/world-model and the integer sim tick (F1.2), never the wall clock or ambient randomness.';

/** Bans wall-clock time and ambient randomness (type:domain libs and sim-cli). */
const determinismRules = {
  'no-restricted-properties': [
    'error',
    {
      object: 'Math',
      property: 'random',
      message: `Math.random() is banned in domain code and sim-cli. ${determinismHint}`,
    },
    { object: 'Date', property: 'now', message: `Date.now() is banned in domain code and sim-cli. ${determinismHint}` },
    ...['performance', 'crypto', 'Date', 'Math'].map((property) => ({
      object: 'globalThis',
      property,
      message: `globalThis.${property} is banned in domain code and sim-cli (it bypasses the determinism lint). ${determinismHint}`,
    })),
  ],
  'no-restricted-globals': [
    'error',
    {
      name: 'performance',
      message: `performance (performance.now() etc.) is banned in domain code and sim-cli. ${determinismHint}`,
    },
    {
      name: 'crypto',
      message: `crypto (randomUUID, getRandomValues) is banned in domain code and sim-cli. Entity ids come from the world counter. ${determinismHint}`,
    },
  ],
  'no-restricted-syntax': [
    'error',
    {
      selector: "NewExpression[callee.name='Date']",
      message: `new Date() is banned in domain code and sim-cli. ${determinismHint}`,
    },
    {
      selector: "CallExpression[callee.name='Date']",
      message: `Date() is banned in domain code and sim-cli. ${determinismHint}`,
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
  ...[domainLibsDir, simCliDir].map((basePath) => ({
    basePath,
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts', '**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'],
    ignores: ['**/*.config.*', 'vitest.domain.mts'],
    rules: determinismRules,
  })),
  // Domain source runs in the renderer and the sim worker as well as Node, so no Node built-ins.
  // Specs run only under Vitest in Node and may use them (e.g. node:fs to read fixtures).
  {
    basePath: domainLibsDir,
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts', '**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'],
    ignores: ['**/*.config.*', 'vitest.domain.mts', '**/*.spec.*', '**/*.test.*'],
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
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.cts', '**/*.mts', '**/*.js', '**/*.jsx', '**/*.cjs', '**/*.mjs'],
    // Override or add rules here
    rules: {},
  },
];

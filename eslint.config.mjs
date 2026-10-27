import nx from '@nx/eslint-plugin';

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
            { sourceTag: 'type:domain', onlyDependOnLibsWithTags: ['type:domain'] },
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

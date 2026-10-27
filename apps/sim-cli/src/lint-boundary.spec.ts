import { ESLint } from 'eslint';
import { join } from 'node:path';
import { WORKSPACE_ROOT } from './script-loader';

/*
 * Plan F1.6: "sim-cli lint fails on any import outside type:domain". The `scope:headless` constraint
 * in the root eslint.config.mjs does that; this test lints a virtual sim-cli file with the real
 * config, so loosening the rule (or dropping the tag) fails `pnpm verify`.
 */

const BOUNDARY_RULE = '@nx/enforce-module-boundaries';

async function boundaryErrors(source: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: WORKSPACE_ROOT });
  const [result] = await eslint.lintText(source, {
    filePath: join(WORKSPACE_ROOT, 'apps/sim-cli/src/boundary-probe.ts'),
  });
  return result.messages.filter((m) => m.ruleId === BOUNDARY_RULE).map((m) => m.message);
}

describe('scope:headless lint boundary', () => {
  it('rejects imports of non-domain workspace libs and framework packages', async () => {
    const errors = await boundaryErrors(
      [
        "import { Session } from '@controls/feature-session';",
        "import { Renderer } from '@controls/renderer';",
        "import { Platform } from '@controls/platform-api';",
        "import { Scene } from 'three';",
        'export const probe = [Session, Renderer, Platform, Scene];',
      ].join('\n'),
    );
    expect(errors).toEqual([
      'A project tagged with "scope:headless" can only depend on libs tagged with "type:domain"',
      'A project tagged with "scope:headless" can only depend on libs tagged with "type:domain"',
      'A project tagged with "scope:headless" can only depend on libs tagged with "type:domain"',
      'A project tagged with "scope:headless" is not allowed to import "three"',
    ]);
  });

  it('accepts the type:domain libs', async () => {
    const errors = await boundaryErrors(
      [
        "import { createGame } from '@controls/scripting-api';",
        "import { createWorldRegistry } from '@controls/world-model';",
        "import { parseConsoleLine } from '@controls/commands';",
        "import { migrateWorld } from '@controls/save-format';",
        'export const probe = [createGame, createWorldRegistry, parseConsoleLine, migrateWorld];',
      ].join('\n'),
    );
    expect(errors).toEqual([]);
  });
});

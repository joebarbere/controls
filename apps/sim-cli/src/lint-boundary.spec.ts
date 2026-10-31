import { ESLint } from 'eslint';
import { join } from 'node:path';
import { WORKSPACE_ROOT } from './script-loader';

/*
 * Plan F1.6: "sim-cli lint fails on any import outside type:domain". The `scope:headless` constraint
 * in the root eslint.config.mjs does that; this test lints a virtual sim-cli file with the real
 * config, so loosening the rule (or dropping the tag) fails `pnpm verify`.
 */

const BOUNDARY_RULE = '@nx/enforce-module-boundaries';

async function boundaryErrors(source: string, file = 'apps/sim-cli/src/boundary-probe.ts'): Promise<string[]> {
  const eslint = new ESLint({ cwd: WORKSPACE_ROOT });
  const [result] = await eslint.lintText(source, { filePath: join(WORKSPACE_ROOT, file) });
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
        "import { SIM_ENGINE_VERSION } from '@controls/sim-core';",
        'export const probe = [createGame, createWorldRegistry, parseConsoleLine, migrateWorld, SIM_ENGINE_VERSION];',
      ].join('\n'),
    );
    expect(errors).toEqual([]);
  });

  it('rejects the sim worker (type:worker): sim-cli runs the engine in-process', async () => {
    expect(await boundaryErrors("export { SIM_WORKER_PACKAGE } from '@controls/sim-worker';")).toEqual([
      'A project tagged with "scope:headless" can only depend on libs tagged with "type:domain"',
    ]);
  });
});

/*
 * P2 kickoff step 6: `type:worker` (libs/sim-worker) may depend only on type:domain, with domain's
 * banned npm imports; nothing but an app may depend on it, so the renderer and features read
 * snapshot types from @controls/sim-protocol (type:domain).
 */
describe('type:worker lint boundary', () => {
  const workerProbe = 'libs/sim-worker/src/lib/boundary-probe.ts';

  it('lets the worker import the sim domain libs', async () => {
    const source = [
      "import { SIM_ENGINE_VERSION } from '@controls/sim-core';",
      "import { SIM_PROTOCOL_VERSION } from '@controls/sim-protocol';",
      "import { CATALOG_VERSION } from '@controls/catalog';",
      "import { worldHash } from '@controls/world-model';",
      'export const probe = [SIM_ENGINE_VERSION, SIM_PROTOCOL_VERSION, CATALOG_VERSION, worldHash];',
    ].join('\n');
    expect(await boundaryErrors(source, workerProbe)).toEqual([]);
  });

  it('rejects non-domain workspace libs and framework packages in the worker', async () => {
    const source = [
      "import { Renderer } from '@controls/renderer';",
      "import { Session } from '@controls/feature-session';",
      "import { Platform } from '@controls/platform-api';",
      "import { Component } from '@angular/core';",
      "import { Scene } from 'three';",
      'export const probe = [Renderer, Session, Platform, Component, Scene];',
    ].join('\n');
    expect(await boundaryErrors(source, workerProbe)).toEqual([
      'A project tagged with "type:worker" can only depend on libs tagged with "type:domain"',
      'A project tagged with "type:worker" can only depend on libs tagged with "type:domain"',
      'A project tagged with "type:worker" can only depend on libs tagged with "type:domain"',
      'A project tagged with "type:worker" is not allowed to import "@angular/core"',
      'A project tagged with "type:worker" is not allowed to import "three"',
    ]);
  });

  it.each([
    ['type:feature', 'libs/features/session/src/lib/boundary-probe.ts'],
    ['type:rendering', 'libs/rendering/renderer/src/lib/boundary-probe.ts'],
    ['type:ui', 'libs/ui/src/lib/boundary-probe.ts'],
    ['type:platform', 'libs/platform/api/src/lib/boundary-probe.ts'],
    ['type:domain', 'libs/domain/sim-core/src/lib/boundary-probe.ts'],
  ])('rejects %s importing the worker', async (tag, file) => {
    const errors = await boundaryErrors("export { SIM_WORKER_PACKAGE } from '@controls/sim-worker';", file);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(new RegExp(`^A project tagged with "${tag}" can only depend on libs tagged with `));
  });

  it.each([
    ['type:feature', 'libs/features/session/src/lib/boundary-probe.ts'],
    ['type:rendering', 'libs/rendering/renderer/src/lib/boundary-probe.ts'],
  ])('lets %s read snapshot types from @controls/sim-protocol', async (_tag, file) => {
    expect(await boundaryErrors("export { SIM_PROTOCOL_VERSION } from '@controls/sim-protocol';", file)).toEqual([]);
  });
});

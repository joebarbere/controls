import { CATALOG_VERSION } from '@controls/catalog';
import { CURRENT_SCHEMA_VERSION } from '@controls/save-format';
import { SIM_ENGINE_VERSION } from '@controls/sim-core';
import { join } from 'node:path';
import { WORKSPACE_ROOT } from '../script-loader';

/*
 * Test support: the engine-numbered `.ctrl` fixtures the scenario specs load (ADR 0015, "catalogVersion
 * 2"). A save verifies (`continued`) only under the build's engine **and** catalogue version, so from
 * catalogue 2 on a fixture's name carries both: `<scenario>-engine-N-catalog-C.ctrl`. Older fixtures
 * (`<scenario>-engine-N.ctrl`, catalogue 1 or earlier) are kept, never regenerated, and load as
 * `engine-changed`.
 *
 * The build writes saves at the current `schemaVersion`, so this build's fixtures live under
 * `fixtures/v<CURRENT_SCHEMA_VERSION>/ctrl`. A fixture of the same name under an older version's
 * directory (world v3, P3 PR 7: the four `-engine-6-catalog-2.ctrl` written as v2) is kept and must
 * still load as `continued` after migration.
 */

/** The save-format fixtures root. */
const FIXTURES_ROOT = join(WORKSPACE_ROOT, 'libs/domain/save-format/fixtures');

/** Where `.ctrl` fixtures of `schemaVersion` live. */
export function ctrlFixtureDir(schemaVersion: number): string {
  return join(FIXTURES_ROOT, `v${schemaVersion}/ctrl`);
}

/** Where this build's `.ctrl` fixtures live (the current `schemaVersion`). */
export const CTRL_FIXTURE_DIR = ctrlFixtureDir(CURRENT_SCHEMA_VERSION);

/** Every `.ctrl` fixture directory from world v2 on (the engine-numbered fixtures start at v2). */
export const ENGINE_FIXTURE_DIRS: readonly string[] = Array.from({ length: CURRENT_SCHEMA_VERSION - 1 }, (_, i) =>
  ctrlFixtureDir(i + 2),
);

/** An engine-numbered fixture name: engine N, and from catalogue 2 on catalogue C. */
export const ENGINE_FIXTURE_PATTERN = /-engine-(\d+)(?:-catalog-(\d+))?\.ctrl$/;

/** The fixture name this build writes and verifies for `scenario` (`sources` → `sources-engine-6-catalog-2.ctrl`). */
export function currentFixtureName(scenario: string): string {
  return `${scenario}-engine-${SIM_ENGINE_VERSION}-catalog-${CATALOG_VERSION}.ctrl`;
}

/** Absolute path of {@link currentFixtureName}. */
export function currentFixture(scenario: string): string {
  return join(CTRL_FIXTURE_DIR, currentFixtureName(scenario));
}

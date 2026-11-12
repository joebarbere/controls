import { CATALOG_VERSION } from '@controls/catalog';
import { SIM_ENGINE_VERSION } from '@controls/sim-core';
import { join } from 'node:path';
import { WORKSPACE_ROOT } from '../script-loader';

/*
 * Test support: the engine-numbered `.ctrl` fixtures the scenario specs load (ADR 0015, "catalogVersion
 * 2"). A save verifies (`continued`) only under the build's engine **and** catalogue version, so from
 * catalogue 2 on a fixture's name carries both: `<scenario>-engine-N-catalog-C.ctrl`. Older fixtures
 * (`<scenario>-engine-N.ctrl`, catalogue 1 or earlier) are kept, never regenerated, and load as
 * `engine-changed`.
 */

/** Where the world v2 `.ctrl` fixtures live. */
export const CTRL_FIXTURE_DIR = join(WORKSPACE_ROOT, 'libs/domain/save-format/fixtures/v2/ctrl');

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

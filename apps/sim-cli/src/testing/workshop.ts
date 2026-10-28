import { loadLevel, type World } from '@controls/world-model';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE_ROOT } from '../script-loader';

/*
 * Test support: the workshop level the scenarios start from (F1.9). New sandbox with seed 0 starts
 * from exactly this world, so the game-e2e drivers and these headless drivers agree on the hash.
 */

/** Workspace-relative path, as the scenario headers spell it (`--world content/levels/workshop.json`). */
export const WORKSHOP_LEVEL = 'content/levels/workshop.json';

/** Absolute path of the workshop level. */
export const WORKSHOP_LEVEL_PATH = join(WORKSPACE_ROOT, WORKSHOP_LEVEL);

/** The workshop level, validated through the same loader the game uses. */
export function workshopWorld(): World {
  const loaded = loadLevel(JSON.parse(readFileSync(WORKSHOP_LEVEL_PATH, 'utf8')));
  if (!loaded.ok) throw new Error(`${WORKSHOP_LEVEL}: ${loaded.error.message}`);
  return loaded.level;
}

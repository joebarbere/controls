import { SafeString } from '@controls/save-format';
import * as z from 'zod';

/*
 * Sources and their coverage (realism charter, plan §3; catalogue v2, ADR 0015, ADR 0016). Every value
 * in a catalogue entry or table names the source it comes from through a `covers` path, and
 * `parseCatalog` refuses a value nobody covers and a cover that covers nothing.
 *
 * A path is dotted segments. A cover covers the path itself and everything below it (`jacket` covers
 * `jacket.widthMm`); a `*` segment matches any one segment (`terminals.*.methods.screw` covers both
 * terminals' screw specs). One exception: the bare path `terminals` is the terminal **layout**
 * (positions and labels) and covers nothing below it, so a game-design layout source never silently
 * covers a termination spec.
 *
 * The paths an entry needs (`requiredSourcePaths` in `catalog.ts`):
 *
 * - devices: `model.params.<name>`, `sizeMm`, `terminals`, `terminals.<id>.methods.<method>.<field>`,
 *   `fits.<mountType>` (what the device mounts on), `mounts.<id>`, `entries.<id>` and
 *   `interiorVolumeMm3` (an enclosure), `conductor.<field>` (a conductor product);
 * - cables: `conductors.<index>`, `jacket.<field>`;
 * - tools: `capabilities`, `holes.<id>`, `dies.<id>`, `torque`, `boreDiameterMm`;
 * - accessories: `awgRange`, `stranding`, `dies`, `barrelLengthMm`, `studDiameterMm`;
 * - tables: `rows.<key>.<field>` for each sourced field.
 */

const SEGMENT = '(?:[A-Za-z0-9][A-Za-z0-9_-]*)';

/** A source's `covers` path: dotted segments, any but the first may be `*`. */
export const SOURCE_PATH_PATTERN = new RegExp(`^${SEGMENT}(?:\\.(?:${SEGMENT}|\\*))*$`);

/**
 * Where a value comes from. `real-world` values cite a standard, a datasheet class, a physics
 * derivation or a public reference (paraphrased, never copied; no NEC tables, ADR 0003);
 * `game-design` values say they were chosen for play.
 */
export const CatalogSource = z.strictObject({
  id: z
    .string()
    .max(64)
    .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
  kind: z.enum(['real-world', 'game-design']),
  citation: SafeString.min(1).max(1200),
  /** What this source supports, as coverage paths. */
  covers: z.array(z.string().max(120).regex(SOURCE_PATH_PATTERN)).min(1),
});
export type CatalogSource = z.infer<typeof CatalogSource>;

/** Whether the cover path `cover` covers the value at `path`. */
export function coversPath(cover: string, path: string): boolean {
  if (cover === 'terminals') return path === 'terminals';
  const c = cover.split('.');
  const p = path.split('.');
  if (c.length > p.length) return false;
  return c.every((segment, i) => segment === '*' || segment === p[i]);
}

/** One coverage problem: the path, and what is wrong. */
export interface CoverageIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * Checks `sources` against the paths an entry needs: unique source ids, every required path covered,
 * and every cover covering at least one required path.
 */
export function checkCoverage(sources: readonly CatalogSource[], required: readonly string[]): CoverageIssue[] {
  const issues: CoverageIssue[] = [];
  const ids = sources.map((s) => s.id);
  if (new Set(ids).size !== ids.length) issues.push({ path: 'sources', message: 'Source ids must be unique' });
  const covers = [...new Set(sources.flatMap((s) => s.covers))];
  for (const path of required) {
    if (!covers.some((cover) => coversPath(cover, path))) {
      issues.push({ path, message: 'Has no source (realism charter: every value has a source)' });
    }
  }
  for (const cover of covers) {
    if (!required.some((path) => coversPath(cover, path))) {
      issues.push({ path: 'sources', message: `A source covers ${cover}, which the entry doesn't have` });
    }
  }
  return issues;
}

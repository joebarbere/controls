import type { Footprint } from './snap/snap';
import type { CatalogRef } from './types';

/*
 * Built-in props (ADR 0007 "Built-in prop references"): catalogue refs `prop.<name>` at version 1,
 * used until the catalogue lands (P2-P3). Resolving a ref is world-model's job, so the renderer's
 * recipes, the placement maths and scripts all read one table. Sizes are game-design values (generic
 * props, not modelled on any product); each says so in its `source` (realism charter, plan §3).
 */

/** Built-in props are all at catalogue version 1. */
export const BUILTIN_PROP_VERSION = 1;

/** Outer size of a prop in its own frame: width along +x, height along +y, depth along +z (integer mm). */
export interface PropSizeMm {
  readonly widthMm: number;
  readonly heightMm: number;
  readonly depthMm: number;
}

export interface PropSpec {
  /** Catalogue id (`prop.box`); the version is {@link BUILTIN_PROP_VERSION}. */
  readonly id: string;
  readonly title: string;
  /** Which procedural recipe draws it: a box, or a cylinder whose axis is the prop's +z (depth). */
  readonly shape: 'box' | 'cylinder';
  readonly sizeMm: PropSizeMm;
  readonly kind: 'game-design';
  readonly source: string;
}

const spec = (id: string, title: string, shape: PropSpec['shape'], w: number, h: number, d: number): PropSpec => ({
  id,
  title,
  shape,
  sizeMm: { widthMm: w, heightMm: h, depthMm: d },
  kind: 'game-design',
  source: `game-design: generic ${title.toLowerCase()} size (${w} × ${h} × ${d} mm), not modelled on a product`,
});

/** Every built-in prop, sorted by id. */
export const BUILTIN_PROPS: readonly PropSpec[] = [
  spec('prop.bench', 'Bench', 'box', 1800, 900, 750),
  spec('prop.box', 'Box', 'box', 120, 80, 60),
  spec('prop.crate', 'Crate', 'box', 300, 200, 200),
  spec('prop.spool', 'Spool', 'cylinder', 150, 150, 100),
];

/** The built-in prop a catalogue ref points at, or `undefined` (unknown id, or a version other than 1). */
export function builtinProp(ref: CatalogRef): PropSpec | undefined {
  if (ref.version !== BUILTIN_PROP_VERSION) return undefined;
  return BUILTIN_PROPS.find((p) => p.id === ref.id);
}

/**
 * The outline a prop occupies on a mounting surface: its width and height. Its depth stands off the
 * surface along the normal. `undefined` for refs that aren't built-in props (nothing to snap).
 */
export function propFootprint(ref: CatalogRef): Footprint | undefined {
  const prop = builtinProp(ref);
  return prop && { widthMm: prop.sizeMm.widthMm, heightMm: prop.sizeMm.heightMm };
}

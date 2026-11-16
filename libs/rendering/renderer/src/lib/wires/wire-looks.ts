import type { Catalog } from '@controls/catalog';
import { BAKE_UNITS_PER_MM, laneSizeTenths, type CatalogRef, type ConductorColour } from '@controls/world-model';

/*
 * What a routed conductor or cable looks like (F3.2 part 2): which instanced mesh draws it (its
 * **look**, one per insulation or jacket material), its colour and its drawn diameter. Pure and
 * GPU-free (lint-fenced), so the scene-graph snapshot and the instance writes agree with a spec.
 *
 * - **Look** is the insulation table key (`thhnThwn2`, `mtw`, `xhhw2`), `bare` for an uninsulated
 *   conductor, the jacket's key for a cable (`nmbJacket`), or `unknown` for a ref the catalogue
 *   doesn't know. Each look is one `InstancedMesh` with one material, whatever the number of wires.
 * - **Colour** is the conductor's stored base colour (a cable's jacket colour) from the catalogue's
 *   `colours` table: display values, never part of a check. A tracer stripe isn't drawn yet.
 * - **Diameter** is the routing lane's (`laneSizeTenths`: the metal, stranded wider by the concentric
 *   bundle factor, plus twice the insulation and jacket), so a wire is drawn exactly as wide as the
 *   lane the bake packed it into.
 * - **Flat cables** (F3.2 part 4) carry their jacket's real width × height (`flat`, the lane's size):
 *   the renderer draws them as an oval of that section, the wide side across the run
 *   (`flatThinAxis`). Their `diameterMm` is the larger of the two, the radius picking and the
 *   highlight use.
 */

/** Surface finish of a look (game-design: how the material reads under the panel lights). */
export interface WireLookFinish {
  readonly roughness: number;
  readonly metalness: number;
}

/**
 * Finishes by look key (game-design, display only). Nylon-jacketed THHN is glossy, PVC (MTW) satin,
 * XLPE (XHHW-2) and the NM-B jacket matte, bare copper metallic.
 */
export const WIRE_LOOK_FINISHES: Readonly<Record<string, WireLookFinish>> = Object.freeze({
  bare: { roughness: 0.35, metalness: 0.85 },
  thhnThwn2: { roughness: 0.3, metalness: 0 },
  mtw: { roughness: 0.5, metalness: 0 },
  xhhw2: { roughness: 0.7, metalness: 0 },
  nmbJacket: { roughness: 0.85, metalness: 0 },
});

/** The finish of a look the table doesn't list (a new insulation, `unknown`). */
export const DEFAULT_LOOK_FINISH: WireLookFinish = { roughness: 0.55, metalness: 0 };

/** The finish of `look`. */
export const lookFinish = (look: string): WireLookFinish =>
  Object.prototype.hasOwnProperty.call(WIRE_LOOK_FINISHES, look) ? WIRE_LOOK_FINISHES[look] : DEFAULT_LOOK_FINISH;

/** A look for refs the catalogue doesn't know. */
export const UNKNOWN_LOOK = 'unknown';
/** The look of a conductor without insulation. */
export const BARE_LOOK = 'bare';
/** Drawn colour of an unknown colour id or ref (mid grey). */
export const UNKNOWN_WIRE_COLOUR = 0x9a9a9a;

/** How one route is drawn. */
export interface WireAppearance {
  readonly look: string;
  /** sRGB `0xrrggbb`. */
  readonly colour: number;
  /** Drawn overall diameter (mm); for a flat cable the larger side of its section. */
  readonly diameterMm: number;
  /** A flat cable's section (mm): width across its wide side and height through it; `null` when round. */
  readonly flat: { readonly widthMm: number; readonly heightMm: number } | null;
}

/** A colour-table id's display colour as `0xrrggbb`, or {@link UNKNOWN_WIRE_COLOUR}. */
export function colourHex(catalog: Pick<Catalog, 'colour'>, id: string | null | undefined): number {
  const row = id ? catalog.colour(id) : undefined;
  return row ? parseInt(row.srgb.slice(1), 16) : UNKNOWN_WIRE_COLOUR;
}

/** `0xrrggbb` → `#rrggbb` (snapshots and the e2e hook). */
export const hexString = (colour: number): string => `#${colour.toString(16).padStart(6, '0')}`;

/** A single conductor's look, colour and diameter. */
export function conductorAppearance(catalog: Catalog, ref: CatalogRef, colour: ConductorColour | null): WireAppearance {
  const spec = catalog.device(ref)?.conductor;
  const diameterMm = laneSizeTenths(catalog, 'conductor', ref).width / BAKE_UNITS_PER_MM;
  if (!spec) return { look: UNKNOWN_LOOK, colour: colourHex(catalog, colour?.base), diameterMm, flat: null };
  return {
    look: spec.insulation === null ? BARE_LOOK : spec.insulation.key,
    colour: colourHex(catalog, colour?.base),
    diameterMm,
    flat: null,
  };
}

/**
 * A cable's look (its jacket material), its jacket colour, and its section: flat at the jacket's
 * width × height when the catalogue gives one that isn't round, else round.
 */
export function cableAppearance(catalog: Catalog, ref: CatalogRef): WireAppearance {
  const jacket = catalog.cable(ref)?.jacket;
  const size = laneSizeTenths(catalog, 'cable', ref);
  const widthMm = size.width / BAKE_UNITS_PER_MM;
  const heightMm = size.height / BAKE_UNITS_PER_MM;
  const diameterMm = Math.max(widthMm, heightMm);
  const flat = size.width !== size.height ? { widthMm, heightMm } : null;
  if (!jacket) return { look: UNKNOWN_LOOK, colour: UNKNOWN_WIRE_COLOUR, diameterMm, flat };
  return { look: jacket.material.key, colour: colourHex(catalog, jacket.colour), diameterMm, flat };
}

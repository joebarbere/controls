import { type Catalog, gaugeRow } from '@controls/catalog';
import type { CatalogRef, EntityId, Waypoint, World } from '../types';
import { BAKE_UNITS_PER_MM, DEFAULT_LANE_WIDTH_TENTHS } from './constants';
import type { RacewayPath } from './raceways';

/*
 * Duct and conduit lanes (ADR 0017; ADR 0010 "pack lanes deterministically instead" of rope-to-rope
 * collision). Every raceway's occupants are the cables and single conductors with a route waypoint
 * hosted on it. They are ordered **cables by cable id, then single conductors by connection id** (both
 * id spaces, ADR 0015), and each takes the next lane:
 *
 * - in a duct, lanes fill the trough's floor from its `across` minimum, an occupant's width at a time,
 *   then start a new layer above the tallest one so far (a layer past the cover wraps back to the
 *   floor: an over-full duct draws overlapping lanes, it never refuses anything);
 * - in a tube, lanes stack along the part's +z, centred on the axis.
 *
 * A lane is a pure function of the set of (owner, route) pairs and the catalogue: never of insertion
 * order, of the order `world.connections` happens to list them in, or of any collision. Offsets are
 * integer tenths of a millimetre. Assigned at bake, never stored (ADR 0015).
 */

/** An occupant: `c<id>` for a single conductor, `k<id>` for a cable (kept apart: they are two id spaces). */
export type LaneOwner = `c${number}` | `k${number}`;

/** A lane's offset from its raceway's axis, in tenths of mm along the raceway's `across` and `up`. */
export interface LaneOffset {
  readonly across: number;
  readonly up: number;
}

/** Each raceway's lanes, by raceway entity, then by owner. */
export type Lanes = ReadonlyMap<EntityId, ReadonlyMap<LaneOwner, LaneOffset>>;

/** One routed thing as lane assignment reads it. */
interface Occupant {
  readonly owner: LaneOwner;
  readonly kind: 'cable' | 'conductor';
  readonly id: number;
  readonly ref: CatalogRef;
  readonly route: readonly Waypoint[];
}

/**
 * How much wider a stranded conductor is than the solid one of the same area (geometry): a concentric
 * lay of `n = 1 + 3k(k + 1)` round strands in `k` layers lies `2k + 1` strands across, each of
 * diameter `d / √n`, so the bundle is `(2k + 1) / √n` times `d`: 3/√7 ≈ 1.134 for 7 strands, 5/√19 ≈
 * 1.147 for 19, 7/√37 ≈ 1.151 for 37 (the 7-strand factor is the one `resolveTermination`'s nick cap
 * uses, ADR 0018 implementation note 8). Any other count is a bunched or rope lay (MTW's 16 and 26
 * strands), whose fine strands pack closer than the next full concentric layer would suggest: it is
 * capped at the 7-strand factor (`(2k + 1)/√n` would draw 26 strands 1.37× wide). Compact stranding
 * (pressed nearly round, narrower still) isn't marked in the catalogue and is drawn as concentric.
 * Both are follow-ups for a catalogue flag. 1 for a solid conductor. Drawing only.
 */
export function strandedDiameterFactor(strandCount: number): number {
  const seven = 3 / Math.sqrt(7);
  if (strandCount <= 1) return 1;
  let k = 1;
  while (1 + 3 * k * (k + 1) < strandCount) k++;
  return 1 + 3 * k * (k + 1) === strandCount ? (2 * k + 1) / Math.sqrt(strandCount) : seven;
}

/**
 * An occupant's width and height in tenths of mm: a conductor's overall diameter (its metal, stranded
 * as {@link strandedDiameterFactor}, plus twice its insulation and jacket walls), a cable's jacket.
 */
export function laneSizeTenths(
  catalog: Catalog,
  kind: 'cable' | 'conductor',
  ref: CatalogRef,
): { width: number; height: number } {
  if (kind === 'cable') {
    const jacket = catalog.cable(ref)?.jacket;
    if (!jacket) return { width: DEFAULT_LANE_WIDTH_TENTHS, height: DEFAULT_LANE_WIDTH_TENTHS };
    return {
      width: Math.ceil(jacket.widthMm * BAKE_UNITS_PER_MM),
      height: Math.ceil(jacket.heightMm * BAKE_UNITS_PER_MM),
    };
  }
  const spec = catalog.device(ref)?.conductor;
  const bare = spec ? gaugeRow(spec.awg)?.diameterMm : undefined;
  if (!spec || bare === undefined) return { width: DEFAULT_LANE_WIDTH_TENTHS, height: DEFAULT_LANE_WIDTH_TENTHS };
  const metal = spec.stranding === 'stranded' ? bare * strandedDiameterFactor(spec.strandCount) : bare;
  const diameter = metal + 2 * ((spec.insulationThicknessMm ?? 0) + (spec.jacketThicknessMm ?? 0));
  const d = Math.ceil(diameter * BAKE_UNITS_PER_MM);
  return { width: d, height: d };
}

/** The routed things of a world, in lane order: cables by id, then single conductors by id. */
function occupants(world: Pick<World, 'connections' | 'cables'>): Occupant[] {
  const cables: Occupant[] = world.cables.map((c) => ({
    owner: `k${c.id}` as LaneOwner,
    kind: 'cable' as const,
    id: c.id,
    ref: c.ref,
    route: c.route,
  }));
  const conductors: Occupant[] = [];
  for (const c of world.connections) {
    if (c.route === null) continue; // a lead, or a cable's conductor (it follows its cable)
    conductors.push({ owner: `c${c.id}` as LaneOwner, kind: 'conductor', id: c.id, ref: c.ref, route: c.route });
  }
  cables.sort((p, q) => p.id - q.id);
  conductors.sort((p, q) => p.id - q.id);
  return [...cables, ...conductors];
}

/** Lays out one raceway's occupants (already in lane order). */
function layout(path: RacewayPath, sizes: readonly { width: number; height: number }[]): LaneOffset[] {
  const { acrossMin, acrossMax, upMin, upMax } = path.interior;
  const offsets: LaneOffset[] = [];
  if (path.kind === 'conduit') {
    // A centred stack along the part's +z (constant through an elbow's bend).
    const total = sizes.reduce((sum, s) => sum + s.height, 0);
    let at = -Math.floor(total / 2);
    for (const s of sizes) {
      offsets.push({ across: 0, up: Math.min(Math.max(at + Math.floor(s.height / 2), upMin), upMax) + 0 });
      at += s.height;
    }
    return offsets;
  }
  let across = acrossMin;
  let layer = upMin;
  let layerHeight = 0;
  for (const s of sizes) {
    if (across > acrossMin && across + s.width > acrossMax) {
      across = acrossMin;
      layer += layerHeight;
      layerHeight = 0;
      if (layer + s.height > upMax) layer = upMin; // over-full: wrap to the floor
    }
    offsets.push({ across: across + Math.floor(s.width / 2) + 0, up: layer + Math.floor(s.height / 2) + 0 });
    across += s.width;
    layerHeight = Math.max(layerHeight, s.height);
  }
  return offsets;
}

/** Every raceway's lanes (see the module comment). `paths` are the world's raceways (`racewayPaths`). */
export function assignLanes(
  world: Pick<World, 'connections' | 'cables'>,
  catalog: Catalog,
  paths: readonly RacewayPath[],
): Lanes {
  const byEntity = new Map<EntityId, RacewayPath>();
  for (const path of paths) byEntity.set(path.entity, path);
  const members = new Map<EntityId, Occupant[]>();
  for (const occupant of occupants(world)) {
    const seen = new Set<EntityId>();
    for (const w of occupant.route) {
      if ((w.kind !== 'duct' && w.kind !== 'conduit') || w.entity === null || seen.has(w.entity)) continue;
      const path = byEntity.get(w.entity);
      if (path?.kind !== w.kind) continue;
      seen.add(w.entity);
      const list = members.get(w.entity) ?? [];
      list.push(occupant);
      members.set(w.entity, list);
    }
  }
  const lanes = new Map<EntityId, Map<LaneOwner, LaneOffset>>();
  for (const [entity, list] of [...members].sort((p, q) => p[0] - q[0])) {
    const sizes = list.map((o) => laneSizeTenths(catalog, o.kind, o.ref));
    const offsets = layout(byEntity.get(entity) as RacewayPath, sizes);
    lanes.set(entity, new Map(list.map((o, i) => [o.owner, offsets[i]])));
  }
  return lanes;
}

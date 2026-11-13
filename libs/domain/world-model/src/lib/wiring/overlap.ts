import { type BodyState, type Catalog, deviceBodySizeMm } from '@controls/catalog';
import { type CommandFailure, fail } from '@controls/commands';
import { builtinProp } from '../props';
import type { BoxMm } from '../routing/collide';
import type { CatalogRef, EntityId, MountedOn, Transform, World } from '../types';
import { bodyBox } from './checks';

/*
 * Overlap (F3.5, the P1 follow-up "placement overlap checks"). A body is the box `bodyBox` gives the
 * route check (`route-collides`): a catalogue device's or built-in prop's size turned by its
 * quarter-turn orientation, exact; any other orientation is the conservative cube, so a tilted body may
 * be refused near a neighbour it doesn't really touch (refusing more, never less). Bodies overlap when
 * their **open** interiors intersect: touching faces is fine, so devices sit side by side on a rail.
 *
 * Unlike `route-collides`, enclosures are bodies here: nothing may be placed inside a box except what
 * is mounted in it. A device and the enclosure it is mounted on (`mountedOn`) never overlap each other;
 * two devices mounted on the same enclosure do (a rail and the backplate behind it are different
 * mounts, so `mount-full` alone doesn't keep them apart). Mount rules (`checkMount`) run first, so a
 * device that crowds its own mount is `mount-full`, not `overlaps`. Fixtures (level geometry) aren't
 * entities and aren't bodies. `entity.rotate` doesn't check overlap in P3.
 *
 * Raceways (F3.5 part 2) are solid here, though hollow for `route-collides`: a terminal block may not
 * be placed inside a duct. A cut-to-length part's body is its cut length wide (`deviceBodySizeMm`),
 * from its commanded state; a part not placed yet is its entry's default length. Conduit parts joined
 * end to end, and a connector at an entry, only touch (their ends lie on their bodies' faces).
 *
 * Two scopes (decided in F3.5 part 1; a refusal may be relaxed later without changing any replay, and widened only to pairs no earlier log can contain):
 * - `all`: every pair of bodies. The placement maths (`placeInWorld`: the mouse, the keyboard reticle
 *   and scripts) uses it, so a snapped placement never overlaps anything.
 * - `mounting`: only pairs where at least one body is an **enclosure or a mounted device**. The
 *   `entity.place` and `entity.move` commands refuse in this scope (`overlaps`). Logs written before
 *   world v3 hold neither (no enclosure kind or `mountedOn` existed), and several shipped ones place
 *   free props and devices on top of each other (`four-surface`, the P2 goldens, which place at the
 *   origin), so refusing every overlap would stop shipped logs replaying. A console line can still
 *   stack two free props; the mouse and `placeInWorld` can't.
 */

/** Which pairs of bodies count: every pair, or only those with an enclosure or a mounted device. */
export type OverlapScope = 'all' | 'mounting';

/**
 * The body box of `ref` at `transform` with commanded `state` (a cut part's length; `null` for one
 * not placed yet), or `null` for a ref with no size (an unknown ref, a connection).
 */
export function refBodyBox(
  catalog: Catalog,
  ref: CatalogRef,
  transform: Transform,
  state: BodyState = null,
): BoxMm | null {
  const device = catalog.device(ref);
  const size = device ? deviceBodySizeMm(device, state) : (builtinProp(ref)?.sizeMm ?? null);
  return size === null ? null : bodyBox({ transform }, size);
}

/** Whether two boxes' open interiors intersect (touching faces don't). */
export function boxesOverlap(a: BoxMm, b: BoxMm): boolean {
  return (
    a.min.x < b.max.x &&
    b.min.x < a.max.x &&
    a.min.y < b.max.y &&
    b.min.y < a.max.y &&
    a.min.z < b.max.z &&
    b.min.z < a.max.z
  );
}

/** Whether a body takes part in the `mounting` scope: an enclosure, or a device mounted on one. */
function mountingBody(catalog: Catalog, ref: CatalogRef, mountedOn: MountedOn | null): boolean {
  return mountedOn !== null || (catalog.device(ref)?.enclosure ?? null) !== null;
}

/**
 * The first entity (in id order) whose body `ref` at `transform` would overlap in `scope`, or `null`.
 * `self` is the entity being moved (it never overlaps itself or what is mounted on it); `mountedOn` is
 * where the body is mounted (its host isn't an obstacle to it); `state` its commanded state (a cut
 * part's length), `null` for a part not placed yet.
 */
export function overlappingEntity(
  world: Pick<World, 'entities'>,
  catalog: Catalog,
  ref: CatalogRef,
  transform: Transform,
  mountedOn: MountedOn | null,
  self: EntityId | null,
  scope: OverlapScope = 'all',
  state: BodyState = null,
): EntityId | null {
  const mine = refBodyBox(catalog, ref, transform, state);
  if (mine === null) return null;
  const counts = scope === 'all' || mountingBody(catalog, ref, mountedOn);
  for (const other of world.entities) {
    if (other.id === self || other.id === mountedOn?.entity) continue;
    if (self !== null && other.mountedOn?.entity === self) continue;
    if (!counts && !mountingBody(catalog, other.ref, other.mountedOn)) continue;
    const theirs = refBodyBox(catalog, other.ref, other.transform, other.state);
    if (theirs !== null && boxesOverlap(mine, theirs)) return other.id;
  }
  return null;
}

/**
 * The commands' check: `overlaps` if `ref` at `transform` would overlap another entity's body in the
 * `mounting` scope (see {@link overlappingEntity}).
 */
export function checkOverlap(
  world: Pick<World, 'entities'>,
  catalog: Catalog,
  ref: CatalogRef,
  transform: Transform,
  mountedOn: MountedOn | null,
  self: EntityId | null,
  state: BodyState = null,
): CommandFailure | null {
  const other = overlappingEntity(world, catalog, ref, transform, mountedOn, self, 'mounting', state);
  return other === null ? null : fail('overlaps', `It would overlap entity ${other}`);
}

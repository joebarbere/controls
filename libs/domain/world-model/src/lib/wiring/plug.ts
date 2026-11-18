import { type Catalog, type DeviceDefinition, nemaMates, type Outlet, type PlugSpec } from '@controls/catalog';
import { type CommandFailure, fail } from '@controls/commands';
import { findEntity } from '../entity-commands';
import { entityPointMm, isAxisAligned } from '../snap/quarter-turn';
import type { Entity, EntityId, PositionMm, World } from '../types';

/*
 * A cord plug in a receptacle outlet (world v4, ADR 0019, D1): `EntityV4.pluggedInto` on the plugged
 * entity, a relation, not a transform. One check serves the `plug.insert` command (PR 8), the
 * surfaces' pre-checks and the load check, so a crafted save can't hold a plug the command would
 * refuse. Only refused versus accepted is replay format; which code a refusal gets is not.
 *
 * Reach is straight-line (a documented abstraction, ADR 0019): the squared distance from the
 * appliance's cord exit (`plug.cordExitMm`, its own frame) to the outlet's face point
 * (`outlets[].positionMm`, the receptacle's frame), both through `entityPointMm`, against the cord's
 * length squared, compared exactly in integers (coordinates are at most 10⁷ mm, so every square
 * stays a safe integer).
 */

/** What `plug.insert` names: the plugged entity, the receptacle and one of its outlets. */
export interface PlugInsert {
  readonly appliance: EntityId;
  readonly receptacle: EntityId;
  readonly outlet: string;
}

/** The squared reach of a cord: from its exit to an outlet's face, and the cord's length, both mm². */
export interface PlugReach {
  readonly distanceSquaredMm2: number;
  readonly cordLengthSquaredMm2: number;
  /** Whether the cord reaches: `distanceSquaredMm2 ≤ cordLengthSquaredMm2`. */
  readonly reaches: boolean;
}

const squared = (p: PositionMm, q: PositionMm): number => {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const dz = q.z - p.z;
  return dx * dx + dy * dy + dz * dz;
};

/**
 * How far `appliance`'s cord must reach to `outlet` of `receptacle` (for live hints and the
 * `out-of-reach` check), or `null` when either entity isn't at quarter-turns or the catalogue doesn't
 * give the plug or the outlet.
 */
export function plugReach(
  catalog: Catalog,
  appliance: Pick<Entity, 'ref' | 'transform'>,
  receptacle: Pick<Entity, 'ref' | 'transform'>,
  outlet: string,
): PlugReach | null {
  const plug = catalog.device(appliance.ref)?.plug ?? null;
  const face = catalog.device(receptacle.ref)?.outlets.find((o) => o.id === outlet);
  if (plug === null || face === undefined) return null;
  return reachOf(appliance, plug, receptacle, face);
}

function reachOf(
  appliance: Pick<Entity, 'transform'>,
  plug: PlugSpec,
  receptacle: Pick<Entity, 'transform'>,
  outlet: Outlet,
): PlugReach | null {
  const exit = entityPointMm(appliance.transform, plug.cordExitMm);
  const face = entityPointMm(receptacle.transform, outlet.positionMm);
  if (exit === null || face === null) return null;
  const distanceSquaredMm2 = squared(exit, face);
  const cordLengthSquaredMm2 = plug.cordLengthMm * plug.cordLengthMm;
  return { distanceSquaredMm2, cordLengthSquaredMm2, reaches: distanceSquaredMm2 <= cordLengthSquaredMm2 };
}

/** The ids `entity`'s relations name: what it is mounted on, in an entry of, and plugged into. */
const relationTargets = (e: Entity): EntityId[] => [
  ...(e.mountedOn === null ? [] : [e.mountedOn.entity]),
  ...(e.inEntry === null ? [] : [e.inEntry.entity]),
  ...(e.pluggedInto === null ? [] : [e.pluggedInto.entity]),
];

/** Whether `from` reaches `to` through mounts, entries and plugs (the world schema's one cycle walk). */
function dependsOn(world: Pick<World, 'entities'>, from: EntityId, to: EntityId): boolean {
  const seen = new Set<EntityId>();
  const stack = [from];
  while (stack.length > 0) {
    const id = stack.pop() as EntityId;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const entity = findEntity(world, id);
    if (entity) stack.push(...relationTargets(entity));
  }
  return false;
}

/**
 * Checks plugging `appliance`'s cord into `outlet` of `receptacle` (ADR 0019 `plug.insert`), in this
 * order: the appliance exists (`not-found`) and its catalogue entry has a plug (`not-an-appliance`);
 * it isn't plugged already (`already-plugged`; skipped with `existing`, the load check of a stored
 * plug) nor mounted (`mounted`) or in an entry (`in-entry`; defensive, PR 8); the receptacle exists (`not-found`), isn't the appliance and doesn't hang from it through
 * mounts, entries or plugs (`plug-cycle`), and its entry has outlets (`not-a-receptacle`) including
 * that one (`unknown-outlet`); no other plug is in the outlet (`outlet-occupied`); `NEMA_CONFIGS` says
 * the plug mates the outlet (`wrong-configuration`); both are at quarter-turns (`not-axis-aligned`);
 * and the cord reaches (`out-of-reach`, {@link plugReach}).
 */
export function checkPlugInsert(
  world: Pick<World, 'entities'>,
  catalog: Catalog,
  { appliance, receptacle, outlet }: PlugInsert,
  options: { readonly existing?: boolean } = {},
): CommandFailure | null {
  const plugged = findEntity(world, appliance);
  if (!plugged) return fail('not-found', `No entity with id ${appliance}`);
  const plug = catalog.device(plugged.ref)?.plug ?? null;
  if (plug === null) return fail('not-an-appliance', `${plugged.ref.id} has no cord plug`);
  if (!options.existing && plugged.pluggedInto !== null) {
    return fail('already-plugged', `Entity ${appliance} is already plugged in: unplug it first`);
  }
  // Defensive (P4 PR 8): a plug is never with another relation (schema invariant 9), and the catalogue
  // refuses an entry that both fits a mount and has a plug, so no world reaches these today.
  if (plugged.mountedOn !== null) return fail('mounted', `Entity ${appliance} is mounted: it can't be plugged in`);
  if (plugged.inEntry !== null) return fail('in-entry', `Entity ${appliance} is in an entry: it can't be plugged in`);
  const host = findEntity(world, receptacle);
  if (!host) return fail('not-found', `No entity with id ${receptacle}`);
  if (dependsOn(world, receptacle, appliance)) {
    return fail('plug-cycle', `Entity ${receptacle} hangs from entity ${appliance}: it can't take its plug`);
  }
  const device: DeviceDefinition | undefined = catalog.device(host.ref);
  if (!device || device.outlets.length === 0) return fail('not-a-receptacle', `${host.ref.id} has no outlets`);
  const face = device.outlets.find((o) => o.id === outlet);
  if (!face) return fail('unknown-outlet', `${host.ref.id} has no outlet "${outlet}"`);
  const holder = world.entities.find(
    (e) => e.id !== appliance && e.pluggedInto?.entity === receptacle && e.pluggedInto.outlet === outlet,
  );
  if (holder) return fail('outlet-occupied', `Outlet "${outlet}" of entity ${receptacle} holds entity ${holder.id}`);
  if (!nemaMates(plug.config, face.config)) {
    return fail('wrong-configuration', `A ${plug.config} plug doesn't enter a ${face.config} receptacle`);
  }
  if (!isAxisAligned(plugged.transform.orientationMdeg) || !isAxisAligned(host.transform.orientationMdeg)) {
    return fail('not-axis-aligned', 'An appliance and its receptacle are at quarter-turns to plug in');
  }
  const reach = reachOf(plugged, plug, host, face);
  if (reach === null || !reach.reaches) {
    return fail('out-of-reach', `The cord (${plug.cordLengthMm} mm) doesn't reach outlet "${outlet}"`);
  }
  return null;
}

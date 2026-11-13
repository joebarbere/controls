import { BUILTIN_CATALOG, type Catalog } from '@controls/catalog';
import { migrateWorld } from '@controls/save-format';
import { canonicalJson } from '../hash';
import { sha256Hex } from '../sha256';
import type { World } from '../types';
import { autoRoute } from './auto-route';
import { bakeWorldRoutes, centrelineHash } from './bake';
import { racewayPaths } from './raceways';
import { snapWaypoint } from './snap';

/*
 * The routing goldens that must be equal in Node and Chromium (ADR 0017; plan F3.2 part 1,
 * `apps/game-e2e/src/routing-parity.spec.ts`): the baked centreline's hash, and a hash of what the
 * router and the snapper propose on the same world. `world-model`'s `routing/parity.spec.ts` pins both
 * for the routing panel under Node; the e2e computes them in the bundled game through the `?e2e=1`
 * session hook. Never persisted.
 */

export interface RoutingDigests {
  /** `centrelineHash(bakeWorldRoutes(world))`. */
  readonly centreline: string;
  /**
   * SHA-256 of the canonical JSON of `autoRoute` between the two landed ends of every routed conductor
   * (by id, with its stored termination methods), and `snapWaypoint` at a point 7, 5 and 3 mm off each
   * raceway's axis midpoint.
   */
  readonly proposals: string;
}

/** The routing digests of `world` (see the module comment). */
export function routingDigests(world: World, catalog: Catalog): RoutingDigests {
  const routes: unknown[] = [];
  for (const c of [...world.connections].sort((p, q) => p.id - q.id)) {
    if (c.route === null || c.a === null || c.b === null || !c.a.termination || !c.b.termination) continue;
    const a = { entity: c.a.entity, terminal: c.a.terminal, termination: { method: c.a.termination.method } };
    const b = { entity: c.b.entity, terminal: c.b.terminal, termination: { method: c.b.termination.method } };
    routes.push([c.id, autoRoute(world, catalog, a, b)]);
  }
  const snaps = racewayPaths(world, catalog).map((p) => {
    const cursor = { x: (p.a.x + p.b.x) / 2 + 7, y: (p.a.y + p.b.y) / 2 + 5, z: (p.a.z + p.b.z) / 2 + 3 };
    return [p.entity, snapWaypoint(world, catalog, cursor)];
  });
  return {
    centreline: centrelineHash(bakeWorldRoutes(world, catalog)),
    proposals: sha256Hex(canonicalJson({ routes, snaps })),
  };
}

/**
 * The routing digests of a world document on the built-in catalogue (migrated and validated first, as
 * `hashWorldDocument` does), or `null` if it doesn't load. What the game's `?e2e=1` hook exposes.
 */
export function routingDigestsOfDocument(input: unknown): RoutingDigests | null {
  const loaded = migrateWorld(input);
  return loaded.ok ? routingDigests(loaded.value, BUILTIN_CATALOG) : null;
}

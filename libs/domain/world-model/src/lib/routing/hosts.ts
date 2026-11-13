import { type Catalog, racewayOf } from '@controls/catalog';
import { fixtureSpec } from '../fixtures';
import type { Entity, Fixture, Waypoint } from '../types';

/*
 * Which hosts a waypoint kind accepts (ADR 0017, deciding what ADR 0015 left to it; `bad-waypoint`):
 *
 * - `duct`: an entity whose catalogue kind is a duct (`raceway: 'duct'`);
 * - `conduit`: an entity whose kind is a conduit part (stick, elbow or connector);
 * - `staple` and `bore`: a stud wall (`prop.stud-wall` fixture; P3 has no stud entities);
 * - `free`: no host (checked by `checkRoute`).
 *
 * Only the host's kind is checked, never whether `positionMm` lies on its axis: the snapper puts it
 * there, the bake draws a hosted waypoint where it is stored (plus its lane), and `routeFloorMm` reads
 * it as stored, so an off-axis waypoint from a hand-written line is a picture problem, not a
 * different circuit. The load check applies the same rule (`checkRouteReferences`) wherever the
 * catalogue knows the host entity or `fixtureSpec` knows the fixture; an unknown host is left alone.
 * Once v3 freezes, a model kind's `raceway` flag and a fixture spec's `kind` are save format: changing
 * either changes which logged routes replay and which saves load.
 */

/** Why `waypoint`'s host doesn't take its kind, or `null`. `host` is the entity or fixture it names (already found). */
export function waypointHostProblem(
  catalog: Catalog,
  waypoint: Pick<Waypoint, 'kind'>,
  host: { readonly entity: Entity } | { readonly fixture: Fixture },
): string | null {
  switch (waypoint.kind) {
    case 'free':
      return null;
    case 'duct':
    case 'conduit': {
      if (!('entity' in host)) return `a ${waypoint.kind} waypoint is on a ${waypoint.kind} part, not a fixture`;
      const device = catalog.device(host.entity.ref);
      const raceway = device ? racewayOf(device) : null;
      return raceway === waypoint.kind ? null : `entity ${host.entity.id} isn't a ${waypoint.kind} part`;
    }
    case 'staple':
    case 'bore': {
      if (!('fixture' in host)) return `a ${waypoint.kind} waypoint is on a stud wall, not an entity`;
      return fixtureSpec(host.fixture.ref)?.kind === 'stud-wall'
        ? null
        : `fixture "${host.fixture.id}" isn't a stud wall`;
    }
  }
}

import { BUILTIN_CATALOG } from '@controls/catalog';
import fc from 'fast-check';
import { routingPanelBus } from '../../testing/routing-panel';
import type { World } from '../types';
import { bakeWorldRoutes, centrelineHash } from './bake';
import { assignLanes, laneSizeTenths, type Lanes } from './lanes';
import { racewayPaths } from './raceways';

const wired = routingPanelBus(true).state;
const paths = racewayPaths(wired, BUILTIN_CATALOG);
const flat = (lanes: Lanes) => [...lanes].map(([entity, owners]) => [entity, [...owners]]);

describe('assignLanes (ADR 0017)', () => {
  it('packs each duct’s occupants from its floor corner by connection id, an overall diameter apart', () => {
    // 14 AWG THHN: 1.628 mm bare + 2 × (0.381 + 0.102) mm = 2.594 mm, so a lane is 26 tenths wide.
    expect(
      laneSizeTenths(BUILTIN_CATALOG, 'conductor', { id: 'conductor.tallowmere-thhn-14-solid', version: 1 }),
    ).toEqual({
      width: 26,
      height: 26,
    });
    const lanes = assignLanes(wired, BUILTIN_CATALOG, paths);
    // D1's trough: 2 mm walls on a 40 × 60 duct whose axis is at (·, 20, 30): across −180 … 180, up from −280.
    expect([...(lanes.get(1) ?? [])]).toStrictEqual([
      ['c1', { across: -167, up: -267 }],
      ['c3', { across: -141, up: -267 }],
      ['c4', { across: -115, up: -267 }],
      ['c5', { across: -89, up: -267 }],
      ['c6', { across: -63, up: -267 }],
      ['c7', { across: -37, up: -267 }],
    ]);
    expect([...(lanes.get(3) ?? [])].map(([owner]) => owner)).toStrictEqual(['c3', 'c5', 'c6']);
  });

  it('a full layer starts another above it', () => {
    const many: World = {
      ...wired,
      connections: Array.from({ length: 15 }, (_, i) => ({ ...wired.connections[0], id: i + 1 })),
      nextConnectionId: 16,
    };
    const lanes = [...(assignLanes(many, BUILTIN_CATALOG, paths).get(1) ?? [])];
    // 36 mm across holds 13 lanes of 2.6 mm; the 14th starts the next layer, 2.6 mm up.
    expect(lanes[12][1]).toStrictEqual({ across: -180 + 12 * 26 + 13, up: -267 });
    expect(lanes[13][1]).toStrictEqual({ across: -167, up: -241 });
  });

  it('are identical whatever order the world lists its connections and cables in (property)', () => {
    const lanes = flat(assignLanes(wired, BUILTIN_CATALOG, paths));
    const hash = centrelineHash(bakeWorldRoutes(wired, BUILTIN_CATALOG));
    const n = wired.connections.length;
    fc.assert(
      fc.property(fc.shuffledSubarray([...wired.connections], { minLength: n, maxLength: n }), (shuffled) => {
        const permuted: World = { ...wired, connections: shuffled };
        expect(flat(assignLanes(permuted, BUILTIN_CATALOG, paths))).toStrictEqual(lanes);
        expect(centrelineHash(bakeWorldRoutes(permuted, BUILTIN_CATALOG))).toBe(hash);
      }),
      { numRuns: 50 },
    );
  });

  it('are identical whatever order the wires were added in (property: same ids, any insertion order)', () => {
    // Insert the same (id, route) pairs one at a time in a random order; the world's array ends up in
    // that order, the lanes don't.
    const lanes = flat(assignLanes(wired, BUILTIN_CATALOG, paths));
    const n = wired.connections.length;
    fc.assert(
      fc.property(fc.shuffledSubarray([...wired.connections], { minLength: n, maxLength: n }), (order) => {
        let world: World = { ...wired, connections: [] };
        for (const c of order) world = { ...world, connections: [...world.connections, c] };
        expect(flat(assignLanes(world, BUILTIN_CATALOG, paths))).toStrictEqual(lanes);
      }),
      { numRuns: 50 },
    );
  });
});

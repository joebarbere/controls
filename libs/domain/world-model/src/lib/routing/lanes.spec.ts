import { BUILTIN_CATALOG } from '@controls/catalog';
import fc from 'fast-check';
import { routingPanelBus } from '../../testing/routing-panel';
import type { World } from '../types';
import { bakeWorldRoutes, centrelineHash } from './bake';
import { assignLanes, laneSizeTenths, type Lanes } from './lanes';
import { racewayPaths } from './raceways';

const wired = routingPanelBus(true).state;
const paths = racewayPaths(wired, BUILTIN_CATALOG);
const NM = { id: 'cable.sorrelby-nmb-14-2', version: 1 };
const free = (x: number, y: number) => ({
  kind: 'free' as const,
  positionMm: { x, y, z: 30 },
  entity: null,
  fixture: null,
  tool: null,
});
const inDuct = (x: number) => ({
  kind: 'duct' as const,
  positionMm: { x, y: 20, z: 30 },
  entity: 1,
  fixture: null,
  tool: null,
});
/** Two NM-B cables laid along D1 with free ends (lane order reads only ids, refs and routes). */
const cable = (id: number, x: number) => ({
  id,
  ref: NM,
  a: null,
  b: null,
  route: [free(x, -100), inDuct(x), inDuct(x + 200), free(x + 200, -100)],
  lengthMm: 1000,
  tailsMm: { a: 0, b: 0 },
  jacketStripMm: { a: 0, b: 0 },
  label: null,
  extensions: {},
});
const withCables: World = { ...wired, cables: [cable(1, 100), cable(2, 150)], nextCableId: 3 };
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

  it('puts cables first, by cable id, then single conductors by connection id (ADR 0015 §6)', () => {
    // NM-B 14/2: a 9.4 × 4.7 mm jacket, so 94 tenths across and 47 up.
    expect(laneSizeTenths(BUILTIN_CATALOG, 'cable', NM)).toEqual({ width: 94, height: 47 });
    const lanes = [...(assignLanes(withCables, BUILTIN_CATALOG, paths).get(1) ?? [])];
    expect(lanes.slice(0, 3)).toStrictEqual([
      ['k1', { across: -180 + 47, up: -280 + 23 }],
      ['k2', { across: -180 + 94 + 47, up: -280 + 23 }],
      ['c1', { across: -180 + 188 + 13, up: -280 + 13 }],
    ]);
  });

  it('are identical whatever order the world lists (or the wires and cables were inserted in) (property)', () => {
    // Same ids and routes, any order: inserting them one at a time in a random order leaves the
    // world's arrays in that order; the lanes and the centreline hash don't move.
    const lanes = flat(assignLanes(withCables, BUILTIN_CATALOG, paths));
    const hash = centrelineHash(bakeWorldRoutes(withCables, BUILTIN_CATALOG));
    const n = withCables.connections.length;
    const k = withCables.cables.length;
    fc.assert(
      fc.property(
        fc.shuffledSubarray([...withCables.connections], { minLength: n, maxLength: n }),
        fc.shuffledSubarray([...withCables.cables], { minLength: k, maxLength: k }),
        (connections, cables) => {
          const permuted: World = { ...withCables, connections, cables };
          expect(flat(assignLanes(permuted, BUILTIN_CATALOG, paths))).toStrictEqual(lanes);
          expect(centrelineHash(bakeWorldRoutes(permuted, BUILTIN_CATALOG))).toBe(hash);
        },
      ),
      { numRuns: 50 },
    );
  });
});

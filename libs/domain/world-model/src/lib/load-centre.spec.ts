import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MODEL_KINDS } from '@controls/catalog';
import type { CommandBus } from '@controls/commands';
import { createWorld, migrateWorld, type World } from '@controls/save-format';
import {
  CUTTER,
  GROUND_BAR_X,
  LOAD_CENTRE_REFS as LC,
  LOAD_CENTRE_TEST_CATALOG,
  MAIN_X,
  MBJ_X,
  spaceMount,
  spacePositionMm,
} from '../testing';
import { checkWorldReferences } from './devices';
import { createWorldBus, createWorldRegistry } from './session';
import { busStabIndex, busStabLeg } from './wiring/mounting';

/*
 * The load centre's kinds on world-model's side (P4 PR 14a, ADR 0019's P4 PR 14 amendment), on the
 * TEST-ONLY entries of `testing/load-centre-catalog.ts`: the first enclosure kind with terminals, so
 * placement, mounting, leads, landings and the load check must not assume an enclosure is electrically
 * empty.
 */

const at = (x: number, y = 0, z = 0) => ({ x, y, z });

function bus(): CommandBus<World> {
  return createWorldBus(
    createWorld({ seed: 5, difficulty: 'trainee' }),
    createWorldRegistry({ catalog: LOAD_CENTRE_TEST_CATALOG }),
  );
}

function exec(b: CommandBus<World>, id: string, args: object): void {
  const result = b.exec(id, args);
  if (!result.ok) throw new Error(`${id} ${JSON.stringify(args)}: ${JSON.stringify(result.error)}`);
}

function code(b: CommandBus<World>, id: string, args: object): string | null {
  const result = b.exec(id, args);
  return result.ok ? null : 'code' in result.error ? result.error.code : result.error.kind;
}

function place(b: CommandBus<World>, ref: object, positionMm: object, mountedOn: object | null = null): number {
  exec(b, 'entity.place', { ref, positionMm, mountedOn });
  return b.state.nextEntityId - 1;
}

/** A load centre (1) at the origin with a main breaker (2), branch breakers in spaces 1, 2 and 3–5 (3–5), an MBJ (6) and a ground bar kit (7). */
function panelBus(): CommandBus<World> {
  const b = bus();
  const panel = place(b, LC.loadCentre, at(0));
  place(b, LC.main, at(MAIN_X), { entity: panel, mount: 'main' });
  for (const [space, ref] of [
    [1, LC.branch20],
    [2, LC.branch20],
    [3, LC.branch2p30],
  ] as const) {
    place(b, ref, spacePositionMm(space), { entity: panel, mount: spaceMount(space) });
  }
  place(b, LC.mbj, at(MBJ_X), { entity: panel, mount: 'mbj' });
  place(b, LC.groundBar, at(GROUND_BAR_X), { entity: panel, mount: 'groundBar' });
  return b;
}

describe('the load centre in the world (P4 PR 14a)', () => {
  it('places with its 44 commanded keys at their initials (the dead front off, no on key) and an empty sim bag', () => {
    const b = bus();
    place(b, LC.loadCentre, at(0));
    const [lc] = b.state.entities;
    expect(Object.keys(lc.state)).toHaveLength(44);
    expect(Object.keys(lc.state).sort()).toStrictEqual(Object.keys(MODEL_KINDS['enclosure.loadCentre'].keys).sort());
    expect([lc.state['coverOn'], lc.state['openEntries'], lc.state['directory20'], lc.state['on']]).toStrictEqual([
      false,
      0,
      null,
      undefined,
    ]);
    expect(lc.sim).toStrictEqual({});
    exec(b, 'device.operate', { id: 1, control: 'coverOn', value: true });
    expect(b.state.entities[0].state['coverOn']).toBe(true);
    expect(code(b, 'device.operate', { id: 1, control: 'directory1', value: 'A' })).toBe('unknown-control');
  });

  it('takes a main on mainFeed, breakers on the stabs, a jumper and a ground bar kit; the load check passes', () => {
    const b = panelBus();
    exec(b, 'panel.directory', { id: 1, space: 1, text: 'KITCHEN SA 1' });
    exec(b, 'panel.directory', { id: 1, space: 20, text: 'SPARE' });
    expect(code(b, 'panel.directory', { id: 1, space: 21, text: 'X' })).toBe('unknown-space');
    expect(checkWorldReferences(b.state, LOAD_CENTRE_TEST_CATALOG)).toStrictEqual([]);
    // A main breaker fits only mainFeed, a branch breaker only the stabs.
    expect(
      code(b, 'entity.place', { ref: LC.branch20, positionMm: at(MAIN_X), mountedOn: { entity: 1, mount: 'main' } }),
    ).toBe('mount-mismatch');
    expect(
      code(b, 'entity.place', {
        ref: LC.main,
        positionMm: spacePositionMm(9),
        mountedOn: { entity: 1, mount: 'left' },
      }),
    ).toBe('mount-mismatch');
    // mainFeed is single: main lugs can't join the main breaker.
    expect(
      code(b, 'entity.place', { ref: LC.mainLugs, positionMm: at(MAIN_X), mountedOn: { entity: 1, mount: 'main' } }),
    ).toBe('mount-full');
  });

  it('spaces alternate columns row by row: spaces 1 and 2 on busL1, 3 and 4 on busL2', () => {
    const b = bus();
    place(b, LC.loadCentre, at(0));
    const host = b.state.entities[0];
    const device = LOAD_CENTRE_TEST_CATALOG.device(LC.loadCentre);
    const fit = { crossMm: 0 };
    const legs = [1, 2, 3, 4, 5, 6].map((space) => {
      const mount = device?.enclosure?.mounts.find((m) => m.id === spaceMount(space));
      if (mount === undefined) throw new Error('no mount');
      const index = busStabIndex(host, mount, spacePositionMm(space), fit);
      return index === null ? null : busStabLeg(mount, index);
    });
    expect(legs).toStrictEqual(['busL1', 'busL1', 'busL2', 'busL2', 'busL1', 'busL1']);
  });

  it("clips a lead to a bus bar or the can and lands a conductor on the host's own neutral bar (no collision with the host)", () => {
    const b = panelBus();
    exec(b, 'lead.connect', {
      ref: { id: 'lead.quillfern-test-1m', version: 1 },
      a: { entity: 1, terminal: 'busL1' },
      b: { entity: 1, terminal: 'chassis' },
    });
    // The branch breaker's load screw (entity 3) to n1 of the load centre it is mounted on, by a route
    // that only runs inside the (hollow) can; the endpoints' own bodies never collide.
    exec(b, 'wire.add', {
      ref: { id: 'conductor.test-14', version: 1 },
      a: { entity: 3, terminal: 'load', termination: 'auto' },
      b: { entity: 1, terminal: 'n1', termination: 'auto' },
      route: [
        { kind: 'free', positionMm: at(10, -20, 60), entity: null, fixture: null, tool: null },
        { kind: 'free', positionMm: at(0, -20, 60), entity: null, fixture: null, tool: null },
      ],
      lengthMm: 500,
      colour: { base: 'white', stripe: null },
      tool: CUTTER,
    });
    // An EGC landed on the ground bar kit's g1, likewise.
    exec(b, 'wire.add', {
      ref: { id: 'conductor.test-14-bare', version: 1 },
      a: { entity: 7, terminal: 'g1', termination: 'auto' },
      b: { entity: 1, terminal: 'n2', termination: 'auto' },
      route: [
        { kind: 'free', positionMm: at(GROUND_BAR_X, -20, 60), entity: null, fixture: null, tool: null },
        { kind: 'free', positionMm: at(10, -20, 60), entity: null, fixture: null, tool: null },
      ],
      lengthMm: 1000,
      colour: { base: 'bare', stripe: null },
      tool: CUTTER,
    });
    expect(b.state.connections).toHaveLength(3);
    expect(checkWorldReferences(b.state, LOAD_CENTRE_TEST_CATALOG)).toStrictEqual([]);
    // A bus bar is clip-only: nothing lands on it.
    expect(
      code(b, 'wire.add', {
        ref: { id: 'conductor.test-14', version: 1 },
        a: { entity: 3, terminal: 'load', termination: 'auto' },
        b: { entity: 1, terminal: 'busL2', termination: 'auto' },
        route: [],
        lengthMm: 500,
        colour: { base: 'black', stripe: null },
        tool: CUTTER,
      }),
    ).not.toBeNull();
  });

  it("save-format's load-centre fixture passes the full load check against the test entries (PR 14 replaces the refs)", () => {
    const json = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../../save-format/fixtures/v4/world/load-centre.json'), 'utf8'),
    );
    const loaded = migrateWorld(json);
    if (!loaded.ok) throw new Error(loaded.error.message);
    const world = loaded.value;
    expect(checkWorldReferences(world, LOAD_CENTRE_TEST_CATALOG)).toStrictEqual([]);
    const lc = world.entities.find((e) => e.ref.id === LC.loadCentre.id);
    expect(Object.keys(lc?.state ?? {})).toHaveLength(44);
    expect(lc?.state).toMatchObject({
      coverOn: true,
      directory1: 'KITCHEN SA 1',
      directory20: 'SPARE',
      directory21: null,
    });
    const mounts = world.entities.map((e) => e.mountedOn?.mount ?? null);
    for (const mount of ['main', 'left', 'right', 'mbj', 'groundBar']) expect(mounts).toContain(mount);
    expect(world.entities.find((e) => e.mountedOn?.mount === 'main')?.ref).toStrictEqual(LC.main);
  });
});

import type { CommandBus } from '@controls/commands';
import type { World } from '@controls/save-format';
import {
  APPLIANCE_12R,
  BOND_OHM,
  BREAKER_1P,
  BREAKER_2P,
  GROUND_BAR,
  LAMP_PLUG,
  MBJ,
  PANEL,
  PIN_OHM,
  RECEPTACLE,
  RESIDENTIAL_TEST_CATALOG,
  RESIDENTIAL_TEST_MODELS,
  residentialBus,
  ROD,
  ROD_OHM,
  SERVICE,
  SERVICE_PARAMS,
  STAB_OHM,
} from '../../testing/residential';
import { UTILITY_SPLIT } from '../../testing/sources';
import { compileNetlist, NetlistCompiler } from './compile';
import { formatNetlist } from './format';
import { computeTopologyHash, topologyBytes } from './hash';
import { EARTH_ENTITY, EARTH_TERMINAL, type Netlist, type NetlistBranch } from './types';

/*
 * Engine 8 part 1 (P4 PR 9, ADR 0019 "What the netlist compiler reads"): relation contacts compiled
 * from `mountedOn`, `pluggedInto` and the earth links, and remote earth as node 0. Each case is built
 * with the real world commands on the TEST-ONLY residential catalogue (`testing/residential.ts`).
 */

const compile = (world: World): Netlist =>
  compileNetlist(world, RESIDENTIAL_TEST_CATALOG, { models: RESIDENTIAL_TEST_MODELS });

function exec(bus: CommandBus<World>, id: string, args: object): void {
  const result = bus.exec(id, args);
  if (!result.ok) throw new Error(`${id} ${JSON.stringify(args)}: ${JSON.stringify(result.error)}`);
}

const at = (x: number, y = 0, z = 0) => ({ x, y, z });

function place(
  bus: CommandBus<World>,
  ref: object,
  positionMm = at(0, 0, 1000),
  mountedOn: object | null = null,
): number {
  exec(bus, 'entity.place', { ref, positionMm, mountedOn });
  return bus.state.nextEntityId - 1;
}

/** A panel at the origin; returns its id. */
const panel = (bus: CommandBus<World>): number => place(bus, PANEL, at(0));
/** A plug-on breaker on the panel's bus at stab `stab` (x = 25 · stab). */
const breaker = (bus: CommandBus<World>, host: number, stab: number, ref = BREAKER_1P): number =>
  place(bus, ref, at(25 * stab), { entity: host, mount: 'bus' });

const contacts = (netlist: Netlist): NetlistBranch[] => netlist.branches.filter((b) => b.element.kind === 'contact');
const member = (netlist: Netlist, node: number) => netlist.nodes[node].members;
const nodeOf = (netlist: Netlist, entity: number, terminal: string) =>
  netlist.nodes.find((n) => n.members.some((m) => m.entity === entity && m.terminal === terminal))?.index ?? -1;

describe('mount contacts (ADR 0019 1–2)', () => {
  it('a plug-on breaker reaches the bus leg of its stab through one stab-contact resistor', () => {
    const bus = residentialBus();
    const host = panel(bus);
    const one = breaker(bus, host, 0); // stab 0: busL1
    const two = breaker(bus, host, 2, BREAKER_2P); // stabs 2 and 3: busL1 and busL2
    const netlist = compile(bus.state);
    expect(netlist.diagnostics).toStrictEqual([]);
    const found = contacts(netlist);
    expect(found.map((b) => b.element)).toStrictEqual([
      { kind: 'contact', entity: one, relation: 'mount', contact: 'line1' },
      { kind: 'contact', entity: two, relation: 'mount', contact: 'line1' },
      { kind: 'contact', entity: two, relation: 'mount', contact: 'line2' },
    ]);
    for (const b of found) {
      expect(b).toMatchObject({
        kind: 'resistor',
        model: 'contact',
        source: null,
        values: { resistanceOhm: STAB_OHM },
      });
    }
    // Contacts come after every entity element: the breakers' poles are branches 0–2.
    expect(found[0].index).toBe(netlist.branches.length - 3);
    // Dependent end a, host end b.
    expect([found[0].a, found[0].b]).toStrictEqual([nodeOf(netlist, one, 'line'), nodeOf(netlist, host, 'busL1')]);
    expect(found[1].b).toBe(nodeOf(netlist, host, 'busL1'));
    expect(found[2].b).toBe(nodeOf(netlist, host, 'busL2'));
  });

  it('sliding a breaker to a stab of the other leg moves the topology; stabs alternate legs by row', () => {
    const bus = residentialBus();
    const host = panel(bus);
    const id = breaker(bus, host, 0);
    const before = compile(bus.state);
    const legs: string[] = [];
    for (const stab of [1, 2, 3]) {
      exec(bus, 'entity.move', { id, positionMm: at(25 * stab) });
      const after = compile(bus.state);
      const leg = after.nodes[contacts(after)[0].b].members[0].terminal;
      legs.push(leg);
      // The netlist (so the hash) is the same exactly when the breaker lands on the same leg.
      expect(after.topologyHash === before.topologyHash).toBe(leg === 'busL1');
    }
    expect(legs).toStrictEqual(['busL2', 'busL1', 'busL2']);
  });

  it('a bond joins the host terminals its mount offers, each through its own contact', () => {
    const bus = residentialBus();
    const host = panel(bus);
    const before = compile(bus.state);
    // Unbonded: the neutral bar and the can are separate nodes.
    expect(nodeOf(before, host, 'neutral')).not.toBe(nodeOf(before, host, 'chassis'));
    const mbj = place(bus, MBJ, at(200), { entity: host, mount: 'mbj' });
    const bar = place(bus, GROUND_BAR, at(250), { entity: host, mount: 'gbar' });
    const netlist = compile(bus.state);
    const found = contacts(netlist);
    expect(found.map((b) => [b.element, b.values])).toStrictEqual([
      [{ kind: 'contact', entity: mbj, relation: 'mount', contact: 'chassis' }, { resistanceOhm: BOND_OHM }],
      [{ kind: 'contact', entity: mbj, relation: 'mount', contact: 'neutral' }, { resistanceOhm: BOND_OHM }],
      [{ kind: 'contact', entity: bar, relation: 'mount', contact: 'chassis' }, { resistanceOhm: BOND_OHM }],
    ]);
    // The jumper's screw node meets the can through one contact and the bar through the other.
    expect(found[0].a).toBe(found[1].a);
    expect(found[0].b).toBe(nodeOf(netlist, host, 'chassis'));
    expect(found[1].b).toBe(nodeOf(netlist, host, 'neutral'));
    expect(netlist.islands[netlist.nodes[found[0].a].island].nodes).toContain(nodeOf(netlist, host, 'neutral'));
  });

  it('a contact whose side is not netlisted is absent and diagnosed; P3 mounts add nothing', () => {
    const bus = residentialBus();
    const host = panel(bus);
    const id = breaker(bus, host, 0);
    const devices = Object.fromEntries(
      Object.entries(RESIDENTIAL_TEST_MODELS.devices).filter(([kind]) => kind !== 'test.plugOn1p'),
    );
    const netlist = compileNetlist(bus.state, RESIDENTIAL_TEST_CATALOG, {
      models: { ...RESIDENTIAL_TEST_MODELS, devices },
    });
    expect(contacts(netlist)).toStrictEqual([]);
    expect(netlist.diagnostics).toContainEqual({
      code: 'absent-contact',
      entity: id,
      relation: 'mount',
      contact: 'line1',
    });
    expect(formatNetlist(netlist)).toContain(`diagnostic absent-contact entity ${id} mount line1`);
  });
});

describe('plug contacts (ADR 0019 4)', () => {
  it('one contact per pin of the plug, by pin id, each the outlet contact resistance', () => {
    const bus = residentialBus();
    const receptacle = place(bus, RECEPTACLE, at(0, 0, 1000));
    const kettle = place(bus, APPLIANCE_12R, at(500, 0, 1000));
    const unplugged = compile(bus.state);
    exec(bus, 'plug.insert', { appliance: kettle, receptacle, outlet: 'face' });
    const netlist = compile(bus.state);
    expect(netlist.topologyHash).not.toBe(unplugged.topologyHash);
    const found = contacts(netlist);
    expect(found.map((b) => b.element)).toStrictEqual(
      ['ground', 'hot', 'neutral'].map((contact) => ({ kind: 'contact', entity: kettle, relation: 'plug', contact })),
    );
    for (const b of found) expect(b.values).toStrictEqual({ resistanceOhm: PIN_OHM });
    expect(found[1].a).toBe(nodeOf(netlist, kettle, 'pHot'));
    expect(found[1].b).toBe(nodeOf(netlist, receptacle, 'hot')); // the slot is joined to its screw
    exec(bus, 'plug.remove', { appliance: kettle });
    expect(compile(bus.state).topologyHash).toBe(unplugged.topologyHash);
  });

  it('a two-blade plug makes two contacts and leaves the ground slot alone', () => {
    const bus = residentialBus();
    const receptacle = place(bus, RECEPTACLE, at(0, 0, 1000));
    const lamp = place(bus, LAMP_PLUG, at(500, 0, 1000));
    exec(bus, 'plug.insert', { appliance: lamp, receptacle, outlet: 'face' });
    expect(contacts(compile(bus.state)).map((b) => b.element)).toStrictEqual(
      ['hot', 'neutral'].map((contact) => ({ kind: 'contact', entity: lamp, relation: 'plug', contact })),
    );
  });
});

describe('remote earth (D5, ADR 0019 6)', () => {
  it('a ground rod links its clamp to the earth node, which is node 0, entity 0, terminal earth', () => {
    const bus = residentialBus();
    const rod = place(bus, ROD);
    const netlist = compile(bus.state);
    expect(member(netlist, 0)).toStrictEqual([{ entity: EARTH_ENTITY, terminal: EARTH_TERMINAL }]);
    expect(netlist.devices).toStrictEqual([{ entity: rod, kind: 'electrode.groundRod' }]);
    expect(netlist.branches).toStrictEqual([
      {
        index: 0,
        element: { kind: 'contact', entity: rod, relation: 'earth', contact: 'electrode' },
        kind: 'resistor',
        model: 'contact',
        source: null,
        a: 1,
        b: 0,
        island: 0,
        values: { resistanceOhm: ROD_OHM },
      },
    ]);
    expect(formatNetlist(netlist)).toContain('node 0 island 0: 0:earth\n');
    expect(formatNetlist(netlist)).toContain(`branch 0 e${rod}:earth.electrode resistor contact 1 -> 0 island 0`);
  });

  it('the service grounds its transformer neutral (x0) through the utility grounding resistance', () => {
    const bus = residentialBus();
    const service = place(bus, SERVICE);
    const netlist = compile(bus.state);
    const earth = contacts(netlist);
    expect(earth.map((b) => [b.element, b.values])).toStrictEqual([
      [
        { kind: 'contact', entity: service, relation: 'earth', contact: 'grounding' },
        { resistanceOhm: SERVICE_PARAMS.utilityGroundingOhm },
      ],
    ]);
    expect(earth[0].a).toBe(nodeOf(netlist, service, 'x0'));
    expect(earth[0].b).toBe(0);
    expect(netlist.islands).toHaveLength(1);
    expect(netlist.islands[0].kind).toBe('ac');
  });

  it('the stand-ins have no earth link, so a P3 world never gains an earth node', () => {
    const bus = residentialBus();
    place(bus, UTILITY_SPLIT);
    const netlist = compile(bus.state);
    expect(netlist.nodes.every((n) => n.members.every((m) => m.entity !== EARTH_ENTITY))).toBe(true);
    expect(contacts(netlist)).toStrictEqual([]);
  });

  it('with earth present every other node shifts by one, and leaving it shifts them back', () => {
    const bus = residentialBus();
    place(bus, UTILITY_SPLIT);
    const without = compile(bus.state);
    const rod = place(bus, ROD);
    const withEarth = compile(bus.state);
    expect(withEarth.nodes.length).toBe(without.nodes.length + 2);
    expect(withEarth.nodes.slice(1, 4).map((n) => n.members)).toStrictEqual(without.nodes.map((n) => n.members));
    exec(bus, 'entity.delete', { id: rod });
    expect(compile(bus.state)).toStrictEqual(without);
  });
});

describe('the topology encoding of contacts (ADR 0019 "The CNT encoding stays at version 1")', () => {
  it('tags a contact 2 with its entity, a u8 relation code and its id; earth is entity 0', () => {
    const bus = residentialBus();
    place(bus, ROD);
    const netlist = compile(bus.state);
    const bytes = [...topologyBytes(netlist.nodes, netlist.branches)];
    const ascii = (s: string) => [s.length, ...[...s].map((c) => c.charCodeAt(0))];
    expect(bytes).toStrictEqual([
      ...[0x43, 0x4e, 0x54, 0x01], // CNT 1
      2, // nodes
      1,
      0,
      ...ascii('earth'), // node 0: entity 0's earth
      1,
      1,
      ...ascii('clamp'), // node 1: the rod's clamp
      1, // branches
      2,
      1,
      3,
      ...ascii('electrode'), // a contact: entity 1, relation earth (3), id
      0,
      0,
      ...ascii('contact'), // resistor, passive, model `contact`
      1,
      0, // a → b
    ]);
    expect(netlist.topologyHash).toBe(computeTopologyHash(netlist.nodes, netlist.branches));
  });

  it('pins one golden per relation and for the earth node (values never move them)', () => {
    const goldens = new Map<string, string>();
    const mount = residentialBus();
    breaker(mount, panel(mount), 0);
    goldens.set('mount', compile(mount.state).topologyHash);
    const plug = residentialBus();
    const receptacle = place(plug, RECEPTACLE, at(0, 0, 1000));
    const kettle = place(plug, APPLIANCE_12R, at(500, 0, 1000));
    exec(plug, 'plug.insert', { appliance: kettle, receptacle, outlet: 'face' });
    goldens.set('plug', compile(plug.state).topologyHash);
    const earth = residentialBus();
    place(earth, ROD);
    goldens.set('earth', compile(earth.state).topologyHash);
    const service = residentialBus();
    place(service, SERVICE);
    goldens.set('service', compile(service.state).topologyHash);
    expect(Object.fromEntries(goldens)).toStrictEqual({
      mount: '941004baac894c1aedb7d1391691bde44e3f7e938f6cfe43dc341893e25c1ff4',
      plug: '9a1fb23245c9a09ccda9cdd650d78412d9e45a1374f4085444eb76ba4af91fce',
      earth: '0ee4b43a535e223ef7651250bd17b7cbff249c758bf45703b9cf0d8ec719576a',
      service: '67bb50ca6f36ca6d398ed554f073d60e482fce65af6c9a5e289189f07e9ef872',
    });
  });
});

describe('the incremental compiler with contacts', () => {
  it('matches a from-scratch compile across mounts, slides, plugs, deletes, undo and redo', () => {
    const bus = residentialBus();
    const compiler = new NetlistCompiler(RESIDENTIAL_TEST_CATALOG, { models: RESIDENTIAL_TEST_MODELS });
    const check = () => expect(compiler.compile(bus.state)).toStrictEqual(compile(bus.state));
    const host = panel(bus);
    check();
    const id = breaker(bus, host, 1);
    check();
    exec(bus, 'entity.move', { id, positionMm: at(50) });
    check();
    place(bus, MBJ, at(200), { entity: host, mount: 'mbj' });
    check();
    place(bus, ROD);
    check();
    const receptacle = place(bus, RECEPTACLE, at(0, 0, 2000));
    const kettle = place(bus, APPLIANCE_12R, at(500, 0, 2000));
    exec(bus, 'plug.insert', { appliance: kettle, receptacle, outlet: 'face' });
    check();
    exec(bus, 'entity.delete', { id: receptacle });
    check();
    exec(bus, 'edit.undo', {});
    check();
    exec(bus, 'entity.delete', { id });
    check();
    exec(bus, 'edit.undo', {});
    check();
    exec(bus, 'edit.redo', {});
    check();
  });
});

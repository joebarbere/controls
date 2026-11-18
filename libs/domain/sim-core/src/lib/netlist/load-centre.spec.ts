import type { CommandBus } from '@controls/commands';
import type { World } from '@controls/save-format';
import {
  GROUND_BAR_X,
  LC_BOND_OHM,
  LC_FEED_OHM,
  LC_STAB_OHM,
  LOAD_CENTRE_REFS as LC,
  MAIN_X,
  MBJ_X,
  spaceMount,
  spacePositionMm,
} from '@controls/world-model/testing';
import { benchBus, LEAD, run } from '../../testing/bench';
import { ENGINE_TEST_CATALOG } from '../../testing/engine';
import { compileNetlist, NetlistCompiler } from './compile';
import { DEVICE_NETLIST_MODELS } from './models';
import type { Netlist, NetlistBranch, TerminalRef } from './types';
import { wiringGraph } from './wiring-graph';

/*
 * The load centre's netlist models (P4 PR 14a, ADR 0019's P4 PR 14 amendment), on world-model's
 * TEST-ONLY entries over the real kinds: the neutral bar and the ground bar kit as ideal join groups
 * (no bar resistance, a labelled abstraction), the bus bars and the can as lone terminals joined only
 * through mounted devices, the main bonding jumper's two contacts on its one terminal, and the feed on
 * `mainFeed` through ordinary (non-bus) mount contacts.
 */

const compile = (world: World): Netlist => compileNetlist(world, ENGINE_TEST_CATALOG);
const at = (x: number, y = 0, z = 0) => ({ x, y, z });

function place(bus: CommandBus<World>, ref: object, positionMm: object, mountedOn: object | null = null): number {
  run(bus, 'entity.place', { ref, positionMm, mountedOn });
  return bus.state.nextEntityId - 1;
}
/** A load centre at the origin (entity 1). */
function loadCentre(): CommandBus<World> {
  const bus = benchBus(ENGINE_TEST_CATALOG);
  place(bus, LC.loadCentre, at(0));
  return bus;
}
const branch = (bus: CommandBus<World>, space: number, ref: object = LC.branch20) =>
  place(bus, ref, spacePositionMm(space), { entity: 1, mount: spaceMount(space) });
const mbj = (bus: CommandBus<World>) => place(bus, LC.mbj, at(MBJ_X), { entity: 1, mount: 'mbj' });
const groundBar = (bus: CommandBus<World>) =>
  place(bus, LC.groundBar, at(GROUND_BAR_X), { entity: 1, mount: 'groundBar' });
const feed = (bus: CommandBus<World>, ref: object) => place(bus, ref, at(MAIN_X), { entity: 1, mount: 'main' });

const t = (entity: number, terminal: string): TerminalRef => ({ entity, terminal });
const nodeOf = (netlist: Netlist, ref: TerminalRef) =>
  netlist.nodes.find((n) => n.members.some((m) => m.entity === ref.entity && m.terminal === ref.terminal))?.index ?? -1;
const contacts = (netlist: Netlist, entity: number): NetlistBranch[] =>
  netlist.branches.filter((b) => b.element.kind === 'contact' && b.element.entity === entity);
const NEUTRAL_BAR = ['neutral', ...Array.from({ length: 20 }, (_, i) => `n${i + 1}`)];

describe('enclosure.loadCentre (P4 PR 14a)', () => {
  it('a lone load centre: its neutral bar is one node, the bus bars and the can lone nodes; no element, no diagnostic', () => {
    const netlist = compile(loadCentre().state);
    expect(netlist.diagnostics).toStrictEqual([]);
    expect(netlist.branches).toStrictEqual([]);
    const members = netlist.nodes.map((n) => n.members.map((m) => m.terminal).sort());
    expect(members).toStrictEqual([['busL1'], ['busL2'], ['chassis'], [...NEUTRAL_BAR].sort()]);
  });

  it('the bar topology is built once per entry: the same frozen terminals give the same object', () => {
    const terminals = ENGINE_TEST_CATALOG.terminalIds(LC.loadCentre) as readonly string[];
    const model = DEVICE_NETLIST_MODELS['enclosure.loadCentre'];
    const input = { params: {}, terminals, state: {}, sim: {} };
    const first = model.topology(input);
    expect(model.topology({ ...input, state: { coverOn: true } })).toBe(first);
    expect(first.joins).toStrictEqual([['neutral', ...NEUTRAL_BAR.slice(1).sort()]]);
    expect(first.elements).toStrictEqual([]);
    // Another entry (another terminal array) gets its own: `neutral` and n1 only.
    expect(model.topology({ ...input, terminals: ['busL1', 'busL2', 'chassis', 'n1', 'neutral'] }).joins).toStrictEqual(
      [['neutral', 'n1']],
    );
    // Never `neutral` read as a family member, and a degenerate list joins nothing.
    expect(model.topology({ ...input, terminals: ['neutral'] }).joins).toStrictEqual([]);
    const bar = DEVICE_NETLIST_MODELS['bond.groundBar'].topology({ ...input, terminals: ['bar', 'g1', 'g10', 'g2'] });
    expect(bar.joins).toStrictEqual([['bar', 'g1', 'g10', 'g2']]);
    for (const kind of ['bond.jumper', 'feed.mainLugs']) {
      expect(DEVICE_NETLIST_MODELS[kind].topology({ ...input, terminals: ['l1', 'l2'] })).toStrictEqual({
        joins: [],
        elements: [],
      });
    }
  });

  it('the dead front and the directory change nothing electrical', () => {
    const bus = loadCentre();
    const before = compile(bus.state);
    run(bus, 'device.operate', { id: 1, control: 'coverOn', value: true });
    run(bus, 'panel.directory', { id: 1, space: 1, text: 'KITCHEN' });
    const after = compile(bus.state);
    expect(after.topologyHash).toBe(before.topologyHash);
    expect(after.nodes).toStrictEqual(before.nodes);
  });

  it('an unfed bus: breakers on the stabs reach the bars, nothing feeds them, nothing is reported', () => {
    const bus = loadCentre();
    const one = branch(bus, 1);
    const two = branch(bus, 3);
    const netlist = compile(bus.state);
    expect(netlist.diagnostics).toStrictEqual([]);
    expect(contacts(netlist, one).map((b) => [b.b, b.values])).toStrictEqual([
      [nodeOf(netlist, t(1, 'busL1')), { resistanceOhm: LC_STAB_OHM }],
    ]);
    expect(contacts(netlist, two)[0].b).toBe(nodeOf(netlist, t(1, 'busL2')));
  });

  it('the main bonding jumper: two contacts from its one body terminal, to the neutral bar and to the can', () => {
    const bus = loadCentre();
    const id = mbj(bus);
    const netlist = compile(bus.state);
    expect(netlist.diagnostics).toStrictEqual([]);
    const found = contacts(netlist, id);
    expect(found.map((b) => [b.element, b.kind, b.model, b.values])).toStrictEqual([
      [
        { kind: 'contact', entity: id, relation: 'mount', contact: 'chassis' },
        'resistor',
        'contact',
        { resistanceOhm: LC_BOND_OHM },
      ],
      [
        { kind: 'contact', entity: id, relation: 'mount', contact: 'neutral' },
        'resistor',
        'contact',
        { resistanceOhm: LC_BOND_OHM },
      ],
    ]);
    const body = nodeOf(netlist, t(id, 'body'));
    expect([found[0].a, found[1].a]).toStrictEqual([body, body]);
    expect(found[0].b).toBe(nodeOf(netlist, t(1, 'chassis')));
    expect(found[1].b).toBe(nodeOf(netlist, t(1, 'n7')));
  });

  it('the ground bar kit: bar and g1 … g10 one node, bonded to the can through one contact', () => {
    const bus = loadCentre();
    const id = groundBar(bus);
    const netlist = compile(bus.state);
    const bar = nodeOf(netlist, t(id, 'bar'));
    expect(netlist.nodes[bar].members.map((m) => m.terminal)).toStrictEqual([
      'bar',
      ...Array.from({ length: 10 }, (_, i) => `g${i + 1}`).sort(),
    ]);
    const [kit] = contacts(netlist, id);
    expect([kit.element, kit.a, kit.b]).toStrictEqual([
      { kind: 'contact', entity: id, relation: 'mount', contact: 'chassis' },
      bar,
      nodeOf(netlist, t(1, 'chassis')),
    ]);
  });

  it('mainFeed: a main breaker’s load side and main lugs reach both bars through ordinary mount contacts', () => {
    for (const ref of [LC.main, LC.mainLugs]) {
      const bus = loadCentre();
      const id = feed(bus, ref);
      const netlist = compile(bus.state);
      expect(netlist.diagnostics).toStrictEqual([]);
      const [own1, own2] = ref === LC.main ? ['load1', 'load2'] : ['l1', 'l2'];
      expect(
        contacts(netlist, id).map((b) => [b.element.kind === 'contact' && b.element.contact, b.a, b.b, b.values]),
      ).toStrictEqual([
        [own1, nodeOf(netlist, t(id, own1)), nodeOf(netlist, t(1, 'busL1')), { resistanceOhm: LC_FEED_OHM }],
        [own2, nodeOf(netlist, t(id, own2)), nodeOf(netlist, t(1, 'busL2')), { resistanceOhm: LC_FEED_OHM }],
      ]);
    }
  });

  it('wiringGraph: the bars join their terminals; the neutral and the can stay apart until a jumper is mounted', () => {
    const bus = loadCentre();
    const bar = groundBar(bus);
    const graph = () => wiringGraph(bus.state, ENGINE_TEST_CATALOG);
    let g = graph();
    expect(g.joined(t(1, 'neutral'), t(1, 'n20'))).toBe(true);
    expect(g.joined(t(bar, 'g3'), t(bar, 'bar'))).toBe(true);
    expect(g.joined(t(bar, 'g3'), t(1, 'chassis'))).toBe(true);
    expect(g.joined(t(1, 'neutral'), t(1, 'chassis'))).toBe(false);
    expect(g.joined(t(1, 'n1'), t(bar, 'g1'))).toBe(false);
    expect(g.joined(t(1, 'busL1'), t(1, 'busL2'))).toBe(false);
    mbj(bus);
    g = graph();
    expect(g.joined(t(1, 'neutral'), t(1, 'chassis'))).toBe(true);
    expect(g.joined(t(1, 'n1'), t(bar, 'g1'))).toBe(true);
    expect(g.joined(t(1, 'busL1'), t(1, 'neutral'))).toBe(false);
  });

  it('incremental recompiles equal from-scratch ones through mounts, a lead on the bar, deletes and undo', () => {
    const bus = loadCentre();
    const compiler = new NetlistCompiler(ENGINE_TEST_CATALOG);
    const check = () => expect(compiler.compile(bus.state)).toStrictEqual(compile(bus.state));
    check();
    feed(bus, LC.main);
    check();
    branch(bus, 1);
    branch(bus, 4, LC.branch2p30);
    check();
    const jumper = mbj(bus);
    groundBar(bus);
    check();
    run(bus, 'lead.connect', { ref: LEAD, a: t(1, 'n3'), b: t(1, 'chassis') });
    check();
    run(bus, 'entity.delete', { id: jumper });
    check();
    run(bus, 'edit.undo', {});
    check();
    expect(compile(bus.state).diagnostics).toStrictEqual([]);
  });
});

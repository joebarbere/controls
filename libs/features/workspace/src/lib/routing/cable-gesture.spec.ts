import { BUILTIN_CATALOG } from '@controls/catalog';
import { createWorldRegistry, type Waypoint } from '@controls/world-model';
import { cableRunBus, WIRING_TEST_CATALOG } from '@controls/world-model/testing';
import {
  addCableWaypoint,
  cableSpoolOf,
  cableStepBack,
  cancelCable,
  type EntryOption,
  enclosureEntries,
  IDLE_CABLE,
  nailPlateWarning,
  nearestEntry,
  pickEntry,
  precheck,
  supportProblem,
} from './cable-gesture';

/*
 * F3.2 part 4: the cable gesture's pure state machine and its helpers, on `cableRunBus`'s world (a
 * 2-gang box at the origin with its top clamp open, a DIN panel above with `ko-bottom-2` open).
 */

const ref = (id: string) => ({ id, version: 1 });
const NMB = ref('cable.sorrelby-nmb-14-2');
const CUTTER = ref('tool.veltmark-dc-8');
const free = (x: number, y: number, z: number): Waypoint => ({
  kind: 'free',
  positionMm: { x, y, z },
  entity: null,
  fixture: null,
  tool: null,
});
/** The cable-run world before its cable: the bus with the cable deleted. */
const world = () => {
  const bus = cableRunBus();
  expect(bus.exec('cable.delete', { id: 1 }).ok).toBe(true);
  return bus.state;
};

describe('the cable gesture model (F3.2 part 4)', () => {
  it('a cable assembly is a spool sized by its largest conductor; a conductor or a tool is not', () => {
    expect(cableSpoolOf(BUILTIN_CATALOG, NMB)).toStrictEqual({
      ref: NMB,
      title: 'NM-B 14/2 with ground, copper, 600 V',
      awg: 14,
    });
    expect(cableSpoolOf(BUILTIN_CATALOG, ref('conductor.tallowmere-thhn-14-solid'))).toBeNull();
    expect(cableSpoolOf(BUILTIN_CATALOG, CUTTER)).toBeNull();
    expect(cableSpoolOf(BUILTIN_CATALOG, null)).toBeNull();
  });

  it('lists an enclosure’s entries with why a cable can’t enter; nearestEntry prefers an open one', () => {
    const w = world();
    const options = enclosureEntries(w, BUILTIN_CATALOG, 1) as EntryOption[];
    expect(options.map((o) => [o.entry, o.problem?.code ?? null])).toStrictEqual([
      ['clamp-top-1', null],
      ['clamp-top-2', 'entry-closed'],
      ['clamp-bottom-1', 'entry-closed'],
      ['clamp-bottom-2', 'entry-closed'],
    ]);
    expect(enclosureEntries(w, BUILTIN_CATALOG, 3)).toBeNull(); // a terminal block
    // Right on the closed clamp-top-2, the open top clamp is still the pick.
    expect(nearestEntry(options, { x: 74, y: 92, z: 40 })?.entry).toBe('clamp-top-1');
    // With no open entry, the nearest one comes back with its problem.
    const closed = options.filter((o) => o.problem !== null);
    expect(nearestEntry(closed, { x: 74, y: 0, z: 40 })).toMatchObject({
      entry: 'clamp-bottom-2',
      problem: { code: 'entry-closed' },
    });
    expect(nearestEntry([], { x: 0, y: 0, z: 0 })).toBeNull();
  });

  it('steps: first entry, waypoints, back, cancel; the far entry builds the one cable.add the command accepts', () => {
    const w = world();
    const def = createWorldRegistry({ catalog: BUILTIN_CATALOG }).get('cable.add');
    const check = (args: unknown) => precheck(def, w, args);
    const spool = cableSpoolOf(BUILTIN_CATALOG, NMB);
    if (!spool) throw new Error('no spool');
    const [clamp] = enclosureEntries(w, BUILTIN_CATALOG, 1) as EntryOption[];
    const ko = (enclosureEntries(w, BUILTIN_CATALOG, 2) as EntryOption[]).find((o) => o.entry === 'ko-bottom-2');
    if (!ko) throw new Error('no knockout');

    expect(addCableWaypoint(IDLE_CABLE, free(0, 0, 0)).kind).toBe('ignored'); // nothing before the first entry
    const from = pickEntry(IDLE_CABLE, clamp, spool, CUTTER, check);
    expect(from).toMatchObject({ kind: 'from', gesture: { a: { entity: 1, entry: 'clamp-top-1' } } });
    let g = from.gesture;
    g = addCableWaypoint(g, free(28, 250, 40)).gesture;
    g = addCableWaypoint(g, free(100, 350, 40)).gesture;
    expect(cableStepBack(g)).toMatchObject({ kind: 'removedWaypoint', left: 1 });
    expect(pickEntry(g, clamp, spool, CUTTER, check)).toMatchObject({ kind: 'refused', code: 'same-entry' });
    expect(pickEntry(g, ko, spool, null, check)).toMatchObject({ kind: 'refused', code: 'wrong-tool' });
    const done = pickEntry(g, ko, spool, CUTTER, check);
    expect(done).toMatchObject({
      kind: 'complete',
      gesture: IDLE_CABLE,
      args: {
        ref: NMB,
        a: { entity: 1, entry: 'clamp-top-1' },
        b: { entity: 2, entry: 'ko-bottom-2' },
        route: g.waypoints,
        tailsMm: { a: 200, b: 200 },
        tool: CUTTER,
      },
    });
    expect(cancelCable(g)).toMatchObject({ kind: 'cancelled', gesture: IDLE_CABLE });
    expect(cancelCable(IDLE_CABLE).kind).toBe('putAway');
    expect(cableStepBack({ a: g.a, waypoints: [] }).kind).toBe('clearedFrom');
    // A closed entry is refused with its reason.
    const closed = (enclosureEntries(w, BUILTIN_CATALOG, 1) as EntryOption[])[1];
    expect(pickEntry(IDLE_CABLE, closed, spool, CUTTER, check)).toMatchObject({
      kind: 'refused',
      code: 'entry-closed',
    });
  });

  it('precheck is the command’s own schema and run: bad arguments and refusals come back in its words', () => {
    const w = world();
    const def = createWorldRegistry({ catalog: BUILTIN_CATALOG }).get('cable.strip');
    expect(precheck(def, w, { id: 1 })).toMatchObject({ code: 'bad-args' });
    expect(precheck(def, w, { id: 9, end: 'a', jacketMm: 10, tool: ref('tool.veltmark-ws-nm12') })).toStrictEqual({
      code: 'not-found',
      message: 'No cable with id 9',
    });
    expect(precheck(undefined, w, {})).toMatchObject({ code: 'unknown-command' });
  });

  it('the support rule so far: no staple near the first box is shown, and nothing for a run out of framing', () => {
    const w = world();
    const [clamp] = enclosureEntries(w, BUILTIN_CATALOG, 1) as EntryOption[];
    // The cable-run box isn't on a stud wall and free waypoints aren't framing: no rule applies.
    expect(supportProblem(w, BUILTIN_CATALOG, { a: clamp, waypoints: [free(28, 250, 40)] })).toBeNull();
    // A staple makes it framing: 3 m from the box is too far.
    const staple: Waypoint = { ...free(28, 3000, 40), kind: 'staple', fixture: 'studs' };
    expect(supportProblem(w, BUILTIN_CATALOG, { a: clamp, waypoints: [staple] })).toMatch(
      /^The first staple \(waypoint 1\) is \d+ mm from the box at end a; NM cable is stapled within 304.8 mm/,
    );
    expect(supportProblem(w, BUILTIN_CATALOG, IDLE_CABLE)).toBeNull();
  });

  it('a bore with a bit that leaves under 31.75 mm to the stud edge warns about a nail plate; never refuses', () => {
    const bore = (tool: string): Waypoint => ({ ...free(0, 0, 0), kind: 'bore', fixture: 'studs', tool: ref(tool) });
    expect(nailPlateWarning(WIRING_TEST_CATALOG, bore('tool.test-bit-19'))).toBeNull();
    expect(nailPlateWarning(WIRING_TEST_CATALOG, bore('tool.test-bit-29'))).toBe(
      'A 28.575 mm hole leaves less than 31.75 mm to the stud edge: a nail plate is needed to protect the cable.',
    );
    expect(nailPlateWarning(WIRING_TEST_CATALOG, free(0, 0, 0))).toBeNull();
    expect(nailPlateWarning(WIRING_TEST_CATALOG, bore('tool.unknown'))).toBeNull();
  });
});

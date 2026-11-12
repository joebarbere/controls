import { LEAD_SIM_BAG_V3, World } from '@controls/save-format';
import { WIRING_TEST_CATALOG } from '../testing/wiring-catalog';
import { at, BIT, type Doc, FERRULE, LEAD, termination, wiredWorldDoc as base, WIRE } from '../testing/wired-world';
import { checkWorldReferences } from './devices';

/*
 * The world v3 half of the load check (ADR 0015, "In the load check"): conductors, cables, mounts and
 * terminations against a TEST-ONLY catalogue (`src/testing/wiring-catalog.ts`). Each test breaks one
 * reference of a valid wired world.
 */

const check = (doc: Doc) => checkWorldReferences(World.parse(doc), WIRING_TEST_CATALOG);
const messages = (doc: Doc) => check(doc).map((issue) => `${issue.path}: ${issue.message}`);
const edit = (change: (doc: Doc) => void): Doc => {
  const doc = base();
  change(doc);
  return doc;
};

describe('checkWorldReferences: world v3 (ADR 0015)', () => {
  it('accepts a wired world whose references all agree with the catalogue', () => {
    expect(check(base())).toStrictEqual([]);
  });

  it('a conductor kind is never lead-shaped, a lead kind always is', () => {
    expect(messages(edit((d) => Object.assign(d.connections[4], { ref: WIRE })))).toContain(
      'connections[4].ref: A conductor kind is never lead-shaped',
    );
    expect(messages(edit((d) => Object.assign(d.connections[0], { ref: LEAD })))).toContain(
      'connections[0].ref: A lead kind is always lead-shaped',
    );
  });

  it("each connection's bags have exactly its kind's keys; a lead's end keys stay at their initial values", () => {
    expect(messages(edit((d) => Object.assign(d.connections[0], { sim: {} })))).toContain(
      'connections[0].sim.conductorTempK: Missing (an absent value is null, never a missing key)',
    );
    expect(messages(edit((d) => Object.assign(d.connections[0], { state: { torque: 1 } })))).toContain(
      'connections[0].state.torque: Not a commanded key of model kind test.conductor',
    );
    const hotLead = edit((d) => Object.assign(d.connections[4], { sim: { ...LEAD_SIM_BAG_V3, endATempK: 400 } }));
    expect(messages(hotLead)).toStrictEqual([
      "connections[4].sim.endATempK: A lead's end keys stay at their initial values",
    ]);
    // A lead's conductor does heat (leads join the thermal model, D2).
    const warmLead = edit((d) => Object.assign(d.connections[4], { sim: { ...LEAD_SIM_BAG_V3, conductorTempK: 300 } }));
    expect(check(warmLead)).toStrictEqual([]);
  });

  it("a termination's method is one of the terminal's, its accessory one the method takes", () => {
    const method = (m: string) =>
      edit((d) => ((d.connections[0]['a'] as Record<string, unknown>)['termination'] = termination(1, { method: m })));
    expect(messages(method('springCage'))).toContain(
      'connections[0].a.termination.method: Not a termination method of that terminal',
    );
    const accessory = (ref: object) =>
      edit(
        (d) =>
          ((d.connections[0]['a'] as Record<string, unknown>)['termination'] = termination(1, {
            accessory: { ref, crimpQuality: 1 },
          })),
      );
    expect(check(accessory(FERRULE))).toStrictEqual([]);
    expect(messages(accessory(BIT))).toContain('connections[0].a.termination.accessory.ref: Not an accessory');
    // An accessory this catalogue doesn't know is left alone.
    expect(check(accessory({ id: 'ferrule.mod-x', version: 1 }))).toStrictEqual([]);
  });

  it('a landed end is a terminal of its device, on an axis-aligned device', () => {
    expect(messages(edit((d) => Object.assign(d.connections[0]['a'] as object, { terminal: 'l9' })))).toContain(
      "connections[0].a.terminal: Not a terminal of the entity's device",
    );
    const turned = edit((d) =>
      Object.assign(d.entities[0], {
        transform: { positionMm: at(0, 900, -2000), orientationMdeg: { yaw: 45_000, pitch: 0, roll: 0 } },
      }),
    );
    expect(messages(turned)).toContain('connections[0].a.entity: A conductor lands only on an axis-aligned device');
    // A quarter-turn is fine (exact integer geometry).
    const quarter = edit((d) =>
      Object.assign(d.entities[0], {
        transform: { positionMm: at(0, 900, -2000), orientationMdeg: { yaw: 90_000, pitch: 0, roll: 0 } },
      }),
    );
    expect(check(quarter)).toStrictEqual([]);
  });

  it("a conductor's colour is in the colour table and one its entry is made in", () => {
    expect(messages(edit((d) => Object.assign(d.connections[0], { colour: { base: 'red', stripe: null } })))).toContain(
      'connections[0].colour: The conductor entry is not made in that colour',
    );
    expect(
      messages(edit((d) => Object.assign(d.connections[0], { colour: { base: 'mauve', stripe: null } }))),
    ).toStrictEqual([
      'connections[0].colour.base: Not in the colour table',
      'connections[0].colour: The conductor entry is not made in that colour',
    ]);
    expect(
      check(edit((d) => Object.assign(d.connections[0], { colour: { base: 'green', stripe: 'yellow' } }))),
    ).toStrictEqual([]);
  });

  it('a conductor landed at both ends covers the straight line between them (exact integers)', () => {
    // L1's screw entry is (50, 1150, -1800); the breaker's line entry (120, 345, -1935): d² = 671 150 (d ≈ 819.2).
    expect(check(edit((d) => Object.assign(d.connections[0], { lengthMm: 820 })))).toStrictEqual([]);
    expect(messages(edit((d) => Object.assign(d.connections[0], { lengthMm: 819 })))).toStrictEqual([
      'connections[0].lengthMm: Shorter than the straight line between its landed ends',
    ]);
  });

  it('a bore waypoint names a tool that can bore; a known host is axis-aligned', () => {
    const bore = (tool: object) =>
      edit((d) =>
        Object.assign(d.connections[0], {
          route: [{ kind: 'bore', positionMm: at(50, 1150, -1700), entity: 3, fixture: null, tool }],
        }),
      );
    expect(check(bore(BIT))).toStrictEqual([]);
    expect(messages(bore(FERRULE))).toContain('connections[0].route[0].tool: Not a tool');
    const tilted = edit((d) => {
      Object.assign(d.connections[0], {
        route: [{ kind: 'duct', positionMm: at(50, 1150, -1700), entity: 5, fixture: null, tool: null }],
      });
      Object.assign(d.entities[4], {
        transform: { positionMm: at(-500, 0, 0), orientationMdeg: { yaw: 0, pitch: 1000, roll: 0 } },
      });
    });
    expect(messages(tilted)).toContain(
      'connections[0].route[0].entity: A hosted waypoint is on an axis-aligned entity',
    );
  });

  it('mountedOn names a mount of the host that the device fits; both are axis-aligned', () => {
    expect(
      messages(edit((d) => Object.assign(d.entities[3], { mountedOn: { entity: 3, mount: 'rail-9' } }))),
    ).toContain("entities[3].mountedOn.mount: Not a mount of the host's catalogue entry");
    expect(
      messages(edit((d) => Object.assign(d.entities[4], { mountedOn: { entity: 3, mount: 'rail-1' } }))),
    ).toContain("entities[4].mountedOn.mount: The device does not fit that mount's type");
    const tilted = edit((d) =>
      Object.assign(d.entities[2], {
        transform: { positionMm: at(0, 0, -2000), orientationMdeg: { yaw: 1, pitch: 0, roll: 0 } },
      }),
    );
    expect(messages(tilted)).toContain('entities[3].mountedOn: A mounted device and its host are axis-aligned');
    // A host the catalogue doesn't know is left alone.
    const modHost = edit((d) => Object.assign(d.entities[2], { ref: { id: 'panel.mod-x', version: 1 }, state: {} }));
    expect(check(modHost)).toStrictEqual([]);
  });

  it("an enclosure's openEntries has no bit beyond its entries", () => {
    expect(messages(edit((d) => Object.assign(d.entities[1], { state: { openEntries: 6 } })))).toStrictEqual([
      'entities[1].state.openEntries: Opens an entry the enclosure does not have',
    ]);
    expect(check(edit((d) => Object.assign(d.entities[1], { state: { openEntries: 3 } })))).toStrictEqual([]);
  });

  it('a cable is an assembly with its conductors, each of the assembly’s entry and colour', () => {
    expect(messages(edit((d) => Object.assign(d.cables[0], { ref: WIRE })))).toContain(
      'cables[0].ref: Not a cable assembly',
    );
    const swapped = edit((d) => Object.assign(d.connections[3], { ref: WIRE }));
    expect(messages(swapped)).toContain("connections[3].ref: Not the assembly's conductor entry");
    const recoloured = edit((d) => Object.assign(d.connections[2], { colour: { base: 'black', stripe: null } }));
    expect(messages(recoloured)).toContain("connections[2].colour: Not the assembly conductor's colour");
    const short = edit((d) => d.connections.splice(3, 1));
    expect(messages(short)).toContain('cables[0].ref: One conductor per conductor of the assembly');
    // An assembly this catalogue doesn't know is left alone.
    expect(check(edit((d) => Object.assign(d.cables[0], { ref: { id: 'cable.mod-x', version: 1 } })))).toStrictEqual(
      [],
    );
  });

  it('each cable end is an open entry of an enclosure, with room', () => {
    const end = (b: object) => edit((d) => Object.assign(d.cables[0], { b }));
    expect(messages(end({ entity: 2, entry: 'top' }))).toContain('cables[0].b.entry: The entry is not open');
    expect(messages(end({ entity: 2, entry: 'ko9' }))).toContain('cables[0].b.entry: Not an entry of the enclosure');
    expect(messages(end({ entity: 1, entry: 'ko1' }))).toContain('cables[0].b.entity: Not an enclosure');
    const twice = edit((d) => {
      d.cables.push({ ...d.cables[0], id: 2 });
      d.connections.push(
        ...d.connections.slice(1, 4).map((c, i) => ({ ...c, id: 6 + i, a: null, cable: { id: 2, conductor: i } })),
      );
      Object.assign(d, { nextCableId: 3, nextConnectionId: 9 });
    });
    expect(messages(twice)).toContain('cables[0].b.entry: More cables than the entry takes');
  });

  it('a cable covers its route and both tails (routeFloorMm)', () => {
    // From the free end at (0, 1100, -1800) to ko1 at (1025, 1000, -1970): ⌈1043.8⌉ = 1044, plus 600 of tails.
    const cut = (lengthMm: number) =>
      edit((d) => {
        Object.assign(d.cables[0], { lengthMm });
        for (const c of d.connections.slice(1, 4)) c['lengthMm'] = lengthMm;
      });
    expect(check(cut(1644))).toStrictEqual([]);
    expect(messages(cut(1643))).toStrictEqual(['cables[0].lengthMm: Shorter than its route and tails']);
  });
});

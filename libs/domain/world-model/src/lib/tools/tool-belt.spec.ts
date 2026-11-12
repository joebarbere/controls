import { BUILTIN_CATALOG, TOOL_STEPS } from '@controls/catalog';
import { CABLE, LEAD, PANEL, STRIPPER, WIRE, WIRING_TEST_CATALOG } from '../../testing';
import { suggestTermination } from '../termination';
import { checkTool } from '../wiring/checks';
import {
  armsPlacement,
  beltChoices,
  beltSlotKind,
  beltSlotTitle,
  defaultTool,
  describeDefaultTool,
  toolCan,
} from './tool-belt';

const ref = (id: string, version = 1) => ({ id, version });
const STRIPPERS = ref('tool.veltmark-ws-1018');
const CUTTERS = ref('tool.veltmark-dc-8');
const SCREWDRIVER = ref('tool.veltmark-sd-2');
const TORQUE = ref('tool.calderyn-ts-15');
const LOW_TORQUE = ref('tool.calderyn-ts-03');
const NUT_DRIVER = ref('tool.veltmark-nd-516');
const CRIMPER = ref('tool.veltmark-cr-2210');
const LABELLER = ref('tool.penmarrow-lp-12');
const EMPTY_BELT = Array.from({ length: 9 }, () => null);

describe('beltSlotKind', () => {
  it('a prop or an entity device is placeable; a tool is a tool; a conductor, cable or lead is a spool', () => {
    expect(beltSlotKind(BUILTIN_CATALOG, null)).toBe('empty');
    expect(beltSlotKind(BUILTIN_CATALOG, ref('prop.crate'))).toBe('placeable');
    expect(beltSlotKind(BUILTIN_CATALOG, ref('lamp.lumivane-12v-5w'))).toBe('placeable');
    expect(beltSlotKind(BUILTIN_CATALOG, STRIPPERS)).toBe('tool');
    expect(beltSlotKind(WIRING_TEST_CATALOG, WIRE)).toBe('spool');
    expect(beltSlotKind(WIRING_TEST_CATALOG, CABLE)).toBe('spool');
    expect(beltSlotKind(WIRING_TEST_CATALOG, LEAD)).toBe('spool');
    expect(beltSlotKind(WIRING_TEST_CATALOG, PANEL)).toBe('placeable');
  });

  it('an unknown ref, a wrong version or an accessory arms nothing', () => {
    expect(beltSlotKind(BUILTIN_CATALOG, ref('tool.nothing'))).toBe('unknown');
    expect(beltSlotKind(BUILTIN_CATALOG, ref('tool.veltmark-ws-1018', 2))).toBe('unknown');
    expect(beltSlotKind(BUILTIN_CATALOG, ref('prop.crate', 2))).toBe('unknown');
    expect(beltSlotKind(WIRING_TEST_CATALOG, ref('ferrule.test-14'))).toBe('unknown');
  });

  it('only a placeable slot arms placement: a tool or spool slot never does', () => {
    expect(armsPlacement(BUILTIN_CATALOG, ref('prop.box'))).toBe(true);
    for (const r of [null, STRIPPERS, ref('tool.nothing')]) expect(armsPlacement(BUILTIN_CATALOG, r)).toBe(false);
    for (const r of [WIRE, CABLE, LEAD]) expect(armsPlacement(WIRING_TEST_CATALOG, r)).toBe(false);
  });
});

describe('beltSlotTitle', () => {
  it('names a slot by its entry or prop title, Empty, or the raw ref', () => {
    expect(beltSlotTitle(BUILTIN_CATALOG, null)).toBe('Empty');
    expect(beltSlotTitle(BUILTIN_CATALOG, ref('prop.crate'))).toBe('Crate');
    expect(beltSlotTitle(BUILTIN_CATALOG, TORQUE)).toBe('Torque screwdriver, 1–5 N·m');
    expect(beltSlotTitle(BUILTIN_CATALOG, ref('lamp.lumivane-12v-5w'))).toBe(
      BUILTIN_CATALOG.device(ref('lamp.lumivane-12v-5w'))?.title,
    );
    expect(beltSlotTitle(BUILTIN_CATALOG, ref('tool.nothing', 3))).toBe('tool.nothing v3');
  });
});

describe('toolCan', () => {
  it('agrees with the commands’ checkTool for every built-in tool, step and size', () => {
    for (const tool of BUILTIN_CATALOG.tools) {
      for (const step of TOOL_STEPS) {
        for (const awg of [null, -3, 0, 6, 8, 10, 12, 14, 22]) {
          const checked = checkTool(BUILTIN_CATALOG, { id: tool.id, version: tool.version }, step, awg);
          expect([tool.id, step, awg, toolCan(tool, step, awg)]).toStrictEqual([tool.id, step, awg, checked.ok]);
        }
      }
    }
  });

  it('a stripper with cutting jaws can cut (capability, not kind); the cutters stop at 8 AWG', () => {
    const strippers = BUILTIN_CATALOG.tool(STRIPPERS);
    const cutters = BUILTIN_CATALOG.tool(CUTTERS);
    expect(strippers && toolCan(strippers, 'cut', 12)).toBe(true);
    expect(strippers && toolCan(strippers, 'cut', 8)).toBe(false);
    expect(cutters && toolCan(cutters, 'cut', 8)).toBe(true);
    expect(cutters && toolCan(cutters, 'cut', 6)).toBe(false);
    expect(cutters && toolCan(cutters, 'strip', 14)).toBe(false);
  });
});

describe('defaultTool (ADR 0015: the first matching tool on the belt, else the first catalogue tool by id)', () => {
  it('takes the first belt slot that can do the step for the size', () => {
    const belt = [ref('prop.box'), CUTTERS, STRIPPERS, ...EMPTY_BELT.slice(3)];
    expect(defaultTool(BUILTIN_CATALOG, belt, 'cut', 14)).toMatchObject({ ref: CUTTERS, slot: 2 });
    // The cutters stop at 8 AWG; the strippers at 10, so for 6 AWG neither on the belt reaches.
    expect(defaultTool(BUILTIN_CATALOG, belt, 'cut', 10)).toMatchObject({ ref: CUTTERS, slot: 2 });
    expect(defaultTool(BUILTIN_CATALOG, [STRIPPERS, CUTTERS], 'cut', 14)).toMatchObject({ ref: STRIPPERS, slot: 1 });
    expect(defaultTool(BUILTIN_CATALOG, belt, 'strip', 12)).toMatchObject({ ref: STRIPPERS, slot: 3 });
  });

  it('falls back to the first catalogue tool by id when the belt has none, and says so', () => {
    const drive = defaultTool(BUILTIN_CATALOG, EMPTY_BELT, 'drive');
    // tool.calderyn-ts-03 sorts before tool.calderyn-ts-15, tool.veltmark-nd-516 and tool.veltmark-sd-2.
    expect(drive).toMatchObject({ ref: LOW_TORQUE, slot: null });
    expect(drive && describeDefaultTool(drive)).toBe('Torque screwdriver, 0.3–1.2 N·m (not on the belt)');
    expect(defaultTool(BUILTIN_CATALOG, [SCREWDRIVER], 'drive')).toMatchObject({ ref: SCREWDRIVER, slot: 1 });
    expect(defaultTool(BUILTIN_CATALOG, EMPTY_BELT, 'label')).toMatchObject({ ref: LABELLER, slot: null });
    expect(defaultTool(BUILTIN_CATALOG, EMPTY_BELT, 'crimp', 12)).toMatchObject({ ref: CRIMPER, slot: null });
  });

  it('for a screw, takes only a tool whose drive types fit it (a nut driver never turns a slotted screw)', () => {
    const slotted = ['slotted', 'square'] as const;
    expect(defaultTool(BUILTIN_CATALOG, [NUT_DRIVER, SCREWDRIVER], 'drive', null, slotted)).toMatchObject({
      ref: SCREWDRIVER,
      slot: 2,
    });
    expect(defaultTool(BUILTIN_CATALOG, [NUT_DRIVER], 'drive', null, ['hex'])).toMatchObject({
      ref: NUT_DRIVER,
      slot: 1,
    });
    // Not on the belt: the first catalogue tool by id that fits.
    expect(defaultTool(BUILTIN_CATALOG, [NUT_DRIVER], 'drive', null, slotted)).toMatchObject({
      ref: LOW_TORQUE,
      slot: null,
    });
    expect(defaultTool(BUILTIN_CATALOG, EMPTY_BELT, 'drive', null, ['hex'])).toMatchObject({ ref: NUT_DRIVER });
  });

  it('skips belt slots that are not tools, unknown or can’t reach the size', () => {
    const belt = [ref('prop.box'), ref('tool.nothing'), CUTTERS, null];
    expect(defaultTool(BUILTIN_CATALOG, belt, 'cut', 6)).toBeNull();
    expect(defaultTool(BUILTIN_CATALOG, belt, 'bore')).toBeNull();
    expect(defaultTool(BUILTIN_CATALOG, belt, 'strip', 14)).toMatchObject({ ref: STRIPPERS, slot: null });
  });

  it('takes the newest version of the first matching id', () => {
    // catalog.tools[0] is tool.calderyn-ts-03 (the first id that can torque).
    const v2 = { ...BUILTIN_CATALOG.tool(LOW_TORQUE), version: 2, title: 'Torque screwdriver v2' };
    const catalog = {
      ...BUILTIN_CATALOG,
      tools: [BUILTIN_CATALOG.tool(LOW_TORQUE), v2, ...BUILTIN_CATALOG.tools.slice(1)],
    };
    const chosen = defaultTool(catalog as typeof BUILTIN_CATALOG, EMPTY_BELT, 'torque');
    expect(chosen?.ref).toStrictEqual({ id: LOW_TORQUE.id, version: 2 });
  });

  it('is the test catalogue’s tools too (the commands’ test fixtures): its stripper is found by capability', () => {
    expect(defaultTool(WIRING_TEST_CATALOG, [STRIPPER], 'stripJacket', 12)).toMatchObject({ ref: STRIPPER, slot: 1 });
  });
});

describe('the built-in tools land a conductor (suggestTermination)', () => {
  it('strip in the solid 14 hole and torque the breaker’s 4 N·m screw with the torque screwdriver', () => {
    const breaker = BUILTIN_CATALOG.device(ref('breaker.saltmere-1p-15a'));
    const load = breaker?.terminals.find((t) => t.id === 'load');
    const tools = BUILTIN_CATALOG.tools;
    expect(suggestTermination(load?.methods ?? [], { awg: 14, stranding: 'solid' }, tools)).toMatchObject({
      method: 'screw',
      strip: { tool: STRIPPERS, hole: 'sol14' },
      accessory: null,
      clamp: { tool: TORQUE, torqueNm: 4 },
    });
  });

  it('torque the DIN supply’s 0.5 N·m screw with the low-range torque screwdriver', () => {
    const supply = BUILTIN_CATALOG.device(ref('supply.railwick-din-24v-5a'));
    const pos = supply?.terminals.find((t) => t.id === 'pos');
    const suggestion = suggestTermination(
      pos?.methods ?? [],
      { awg: 16, stranding: 'stranded' },
      BUILTIN_CATALOG.tools,
    );
    expect(suggestion?.clamp).toStrictEqual({ tool: LOW_TORQUE, torqueNm: 0.5 });
  });

  it('never suggest the nut driver for a terminal screw, even with no other plain driver', () => {
    const breaker = BUILTIN_CATALOG.device(ref('breaker.saltmere-1p-15a'));
    const load = breaker?.terminals.find((t) => t.id === 'load');
    const tools = BUILTIN_CATALOG.tools.filter((t) => t.kind !== 'torqueDriver' && t.id !== SCREWDRIVER.id);
    expect(suggestTermination(load?.methods ?? [], { awg: 14, stranding: 'solid' }, tools)).toBeNull();
    const plain = BUILTIN_CATALOG.tools.filter((t) => t.kind !== 'torqueDriver');
    expect(suggestTermination(load?.methods ?? [], { awg: 14, stranding: 'solid' }, plain)?.clamp).toStrictEqual({
      tool: SCREWDRIVER,
      torqueNm: null,
    });
  });
});

describe('beltChoices', () => {
  it('offers the built-in props, the placeable catalogue devices (F3.5), then each catalogue tool once, every choice a slot can hold', () => {
    const choices = beltChoices(BUILTIN_CATALOG);
    expect(choices.map((c) => `${c.group}:${c.ref.id}@${c.ref.version}`)).toStrictEqual([
      'Props:prop.bench@1',
      'Props:prop.box@1',
      'Props:prop.crate@1',
      'Props:prop.spool@1',
      ...BUILTIN_CATALOG.devices
        .filter((d) => d.model.kind !== 'lead' && d.model.kind !== 'conductor')
        .map((d) => `Devices:${d.id}@1`),
      ...BUILTIN_CATALOG.tools.map((t) => `Tools:${t.id}@1`),
    ]);
    // The panel and the breaker are among them; no lead or conductor (spools) is.
    const ids = choices.map((c) => c.ref.id);
    expect(ids).toEqual(expect.arrayContaining(['panel.pellmoor-din-400x500', 'breaker.saltmere-1p-15a']));
    expect(ids.some((id) => id.startsWith('lead.') || id.startsWith('conductor.'))).toBe(false);
    for (const c of choices) {
      expect(beltSlotKind(BUILTIN_CATALOG, c.ref)).toBe(c.group === 'Tools' ? 'tool' : 'placeable');
      expect(c.title).toBe(beltSlotTitle(BUILTIN_CATALOG, c.ref));
    }
  });
});

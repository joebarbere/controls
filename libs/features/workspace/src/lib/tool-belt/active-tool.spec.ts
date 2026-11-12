import { TestBed } from '@angular/core/testing';
import { Session, ToolBelt } from '@controls/feature-session';
import { SettingsStore } from '@controls/feature-settings';
import { describeDefaultTool } from '@controls/world-model';
import { ActiveTool, TOOL_BELT_KIND_KEY, TOOL_BELT_TOOL_KEY } from './active-tool';

const STRIPPERS = { id: 'tool.veltmark-ws-1018', version: 1 };
const TORQUE = { id: 'tool.calderyn-ts-15', version: 1 };

/** Puts `refs` into slots 4, 5, … (slots 1-3 keep the default props). */
function belt(...refs: { id: string; version: number }[]): void {
  const store = TestBed.inject(SettingsStore);
  const slots = [...store.settings().toolBelt.slots];
  refs.forEach((ref, i) => (slots[3 + i] = ref));
  store.update('toolBelt', { slots });
}

describe('ActiveTool (F3.4 part 1)', () => {
  it('joins the active slot with the belt: a prop arms placement, a tool is held and named', async () => {
    const active = TestBed.inject(ActiveTool);
    const session = TestBed.inject(Session);
    belt(STRIPPERS);
    expect(active.label()).toBeNull();
    expect(active.slots().map((s) => s.kind)).toStrictEqual([
      'placeable',
      'placeable',
      'placeable',
      'tool',
      'empty',
      'empty',
      'empty',
      'empty',
      'empty',
    ]);

    session.exec('toolbelt.select', { slot: 2 });
    expect(active.placeable()).toStrictEqual({ id: 'prop.crate', version: 1 });
    expect(active.tool()).toBeNull();
    expect(active.label()).toBe('2: Crate');

    session.exec('toolbelt.select', { slot: 4 });
    expect(active.placeable()).toBeNull();
    expect(active.tool()?.id).toBe(STRIPPERS.id);
    expect(active.label()).toBe('4: Wire strippers, 10–18 AWG solid / 12–20 AWG stranded');
  });

  it('publishes what the slot holds and the tool kind as context keys, for a flow’s `when`', async () => {
    const active = TestBed.inject(ActiveTool);
    const session = TestBed.inject(Session);
    belt(TORQUE);
    TestBed.tick();
    expect(session.contextKeys()[TOOL_BELT_KIND_KEY]).toBeUndefined();

    session.exec('toolbelt.select', { slot: 4 });
    TestBed.tick();
    expect(session.contextKeys()).toMatchObject({ [TOOL_BELT_KIND_KEY]: 'tool', [TOOL_BELT_TOOL_KEY]: 'torqueDriver' });

    session.exec('toolbelt.select', { slot: 1 });
    TestBed.tick();
    expect(session.contextKeys()[TOOL_BELT_KIND_KEY]).toBe('placeable');
    expect(session.contextKeys()[TOOL_BELT_TOOL_KEY]).toBeUndefined();

    TestBed.inject(ToolBelt).clear();
    TestBed.tick();
    expect(session.contextKeys()[TOOL_BELT_KIND_KEY]).toBeUndefined();
    expect(active.active()).toBeNull();
  });

  it('applies the default-tool rule to the belt: the belt first, else the catalogue, and says which', () => {
    const active = TestBed.inject(ActiveTool);
    const fromCatalogue = active.toolFor('strip', 14);
    expect(fromCatalogue && describeDefaultTool(fromCatalogue)).toBe(
      'Wire strippers, 10–18 AWG solid / 12–20 AWG stranded (not on the belt)',
    );
    belt(TORQUE, STRIPPERS);
    expect(active.toolFor('strip', 14)).toMatchObject({ ref: STRIPPERS, slot: 5 });
    expect(active.toolFor('drive')).toMatchObject({ ref: TORQUE, slot: 4 });
    expect(active.toolFor('cut', 6)).toBeNull();
  });
});

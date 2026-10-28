import { TestBed } from '@angular/core/testing';
import { toolBeltBindingId } from '@controls/commands';
import {
  detectKeyPlatform,
  isRestrictedTarget,
  KEY_PLATFORM,
  KEYBINDING_OVERRIDES,
  KeybindingService,
} from './keybinding-service';
import { Session } from './session';
import { TOOL_BELT_SLOT_KEY, ToolBelt } from './tool-belt';

const crate = { id: 'prop.crate', version: 1 };
const place = { ref: crate, positionMm: { x: 10, y: 0, z: -20 } };

function press(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function setup(platform: 'mac' | 'other' = 'other') {
  TestBed.configureTestingModule({ providers: [{ provide: KEY_PLATFORM, useValue: platform }] });
  const keys = TestBed.inject(KeybindingService);
  const session = TestBed.inject(Session);
  const overrides = TestBed.inject(KEYBINDING_OVERRIDES);
  return { keys, session, overrides };
}

describe('KeybindingService', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    document.body.replaceChildren();
  });

  it('runs a command from its default chord, through Session.exec', () => {
    const { session } = setup();
    session.exec('entity.place', place);
    const event = press(document.body, { key: 'z', code: 'KeyZ', ctrlKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(session.world().entities).toEqual([]);
    expect(session.entries().map((e) => e.id)).toEqual(['entity.place', 'edit.undo']);
  });

  it('uses Cmd for Mod on macOS', () => {
    const { session } = setup('mac');
    session.exec('entity.place', place);
    press(document.body, { key: 'z', code: 'KeyZ', ctrlKey: true });
    expect(session.world().entities).toHaveLength(1);
    press(document.body, { key: 'z', code: 'KeyZ', metaKey: true });
    expect(session.world().entities).toEqual([]);
  });

  it('leaves the key alone when the command’s `when` is false', () => {
    const { session } = setup();
    const event = press(document.body, { key: 'z', code: 'KeyZ', ctrlKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(session.entries()).toEqual([]);
  });

  it('ignores handled events, auto-repeat and IME composition', () => {
    const { session } = setup();
    session.exec('entity.place', place);
    const handled = new KeyboardEvent('keydown', {
      key: 'z',
      code: 'KeyZ',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    handled.preventDefault();
    document.body.dispatchEvent(handled);
    expect(press(document.body, { key: 'z', code: 'KeyZ', ctrlKey: true, repeat: true }).defaultPrevented).toBe(true);
    press(document.body, { key: 'z', code: 'KeyZ', ctrlKey: true, isComposing: true });
    expect(session.world().entities).toHaveLength(1);
    press(document.body, { key: 'Shift', code: 'ShiftLeft', shiftKey: true });
    expect(session.entries()).toHaveLength(1);
  });

  it('does not fire non-global bindings while typing or in a dialog', () => {
    const { session } = setup();
    const field = document.createElement('input');
    const checkbox = Object.assign(document.createElement('input'), { type: 'checkbox' });
    const editor = document.createElement('div');
    editor.className = 'cm-editor';
    const line = document.createElement('div');
    editor.append(line);
    document.body.append(field, checkbox, editor);
    press(field, { key: '1', code: 'Digit1' });
    press(line, { key: '2', code: 'Digit2' });
    expect(session.entries()).toEqual([]);
    press(checkbox, { key: '3', code: 'Digit3' });
    expect(session.entries().map((e) => e.args)).toEqual([{ slot: 3 }]);
  });

  it('selects tool-belt slots with keys 1-9 and publishes the active slot', () => {
    const { session } = setup();
    const belt = TestBed.inject(ToolBelt);
    expect(belt.activeSlot()).toBeNull();
    press(document.body, { key: '4', code: 'Digit4' });
    expect(belt.activeSlot()).toBe(4);
    expect(session.contextKeys()[TOOL_BELT_SLOT_KEY]).toBe(4);
    press(document.body, { key: '$', code: 'Digit4', shiftKey: true }); // Shift+4 is a different chord
    expect(session.entries().map((e) => [e.id, e.args])).toEqual([['toolbelt.select', { slot: 4 }]]);
  });

  it('rebinding takes effect at once and persists through the overrides store', () => {
    const { keys, session, overrides } = setup();
    const id = toolBeltBindingId(2);
    expect(keys.setBinding(id, 'q')).toEqual({ ok: true, chord: 'Q' });
    expect(overrides.overrides()).toEqual({ [id]: 'Q' });
    expect(keys.chordsOf(id)).toEqual(['Q']);
    press(document.body, { key: '2', code: 'Digit2' });
    expect(session.entries()).toEqual([]);
    press(document.body, { key: 'q', code: 'KeyQ' });
    expect(session.entries().map((e) => e.args)).toEqual([{ slot: 2 }]);
    expect(keys.customised()).toBe(true);
  });

  it('setting a binding back to its default clears the override; null unbinds', () => {
    const { keys, overrides } = setup();
    keys.setBinding('edit.undo', 'Mod+U');
    expect(keys.setBinding('edit.undo', 'Ctrl+Z')).toEqual({ ok: true, chord: 'Mod+Z' });
    expect(overrides.overrides()).toEqual({});
    expect(keys.setBinding('edit.undo', null)).toEqual({ ok: true, chord: null });
    expect(overrides.overrides()).toEqual({ 'edit.undo': null });
    expect(keys.chordsOf('edit.undo')).toEqual([]);
  });

  it('refuses unknown ids, bad, reserved and wrong-kind chords', () => {
    const { keys, overrides } = setup();
    expect(keys.setBinding('no.such', 'Q')).toMatchObject({ ok: false, error: /Unknown binding/ });
    expect(keys.setBinding('edit.undo', 'Mod+Nope')).toMatchObject({ ok: false, error: /Unknown key/ });
    expect(keys.setBinding('edit.undo', 'Shift+Tab')).toMatchObject({ ok: false, error: /reserved/ });
    expect(keys.setBinding('edit.undo', 'ShiftLeft')).toMatchObject({ ok: false, error: /modifier key/ });
    expect(keys.setBinding('input.moveForward', 'Mod+W')).toMatchObject({ ok: false, error: /single key/ });
    expect(overrides.overrides()).toEqual({});
  });

  it('resets one binding or all of them', () => {
    const { keys, overrides } = setup();
    keys.setBinding('edit.undo', 'Mod+U');
    keys.setBinding('input.moveForward', 'I');
    keys.reset('edit.undo');
    keys.reset('edit.undo'); // no-op
    expect(overrides.overrides()).toEqual({ 'input.moveForward': 'I' });
    keys.resetAll();
    expect(overrides.overrides()).toEqual({});
    expect(keys.customised()).toBe(false);
  });

  it('feeds input-action overrides to the renderer as codes, never to the replay log', () => {
    const { keys, session } = setup();
    expect(keys.inputBindings()['moveForward']).toEqual(['KeyW', 'ArrowUp']);
    keys.setBinding('input.moveForward', 'I');
    expect(keys.inputBindings()['moveForward']).toEqual(['KeyI']);
    press(document.body, { key: 'i', code: 'KeyI' });
    expect(session.entries()).toEqual([]);
  });

  it('shows conflicts instead of shadowing', () => {
    const { keys } = setup();
    keys.setBinding(toolBeltBindingId(3), 'W');
    expect(keys.keymap().conflictsOf('input.moveForward')).toEqual([
      { chord: 'W', first: toolBeltBindingId(3), second: 'input.moveForward' },
    ]);
  });

  it('Delete deletes the selected entity, taking its id from the context (F1.7)', () => {
    const { session } = setup();
    session.exec('entity.place', place);
    session.setContext('viewport.focused', true);
    press(document.body, { key: 'Delete', code: 'Delete' });
    expect(session.world().entities).toHaveLength(1); // nothing selected: the key is left alone
    session.setContext('selection.entityId', 1);
    const event = press(document.body, { key: 'Delete', code: 'Delete' });
    expect(event.defaultPrevented).toBe(true);
    expect(session.world().entities).toEqual([]);
    expect(session.entries().map((e) => [e.id, e.args])).toEqual([
      ['entity.place', { ...place, orientationMdeg: { yaw: 0, pitch: 0, roll: 0 } }],
      ['entity.delete', { id: 1 }],
    ]);
  });

  it('V and F run view.mode and view.focus with arguments from the context (F1.7)', () => {
    const { session } = setup();
    const modes: string[] = [];
    session.onCommand('view.mode', (e) => modes.push((e.command.args as { mode: string }).mode));
    session.setContext('viewport.focused', true);
    session.setContext('mode', 'work');
    press(document.body, { key: 'v', code: 'KeyV' });
    session.setContext('mode', 'walk');
    press(document.body, { key: 'v', code: 'KeyV' });
    expect(modes).toEqual(['walk', 'work']);
    session.setContext('selection.id', 'din-rail-2');
    press(document.body, { key: 'f', code: 'KeyF' }); // not focusable: nothing runs
    session.setContext('selection.focusable', true);
    press(document.body, { key: 'f', code: 'KeyF' });
    expect(session.entries().map((e) => [e.id, e.args])).toEqual([
      ['view.mode', { mode: 'walk' }],
      ['view.mode', { mode: 'work' }],
      ['view.focus', { target: 'din-rail-2' }],
    ]);
  });

  it('labels chords for the platform', () => {
    expect(setup('mac').keys.label('Mod+Shift+Z')).toBe('Cmd+Shift+Z');
    TestBed.resetTestingModule();
    expect(setup('other').keys.label('Mod+Shift+Z')).toBe('Ctrl+Shift+Z');
  });
});

describe('detectKeyPlatform', () => {
  it('recognises macOS from userAgentData, platform or the user agent', () => {
    const nav = (init: object) => init as Navigator;
    expect(detectKeyPlatform(nav({ userAgentData: { platform: 'macOS' }, platform: '', userAgent: '' }))).toBe('mac');
    expect(detectKeyPlatform(nav({ platform: 'MacIntel', userAgent: '' }))).toBe('mac');
    expect(detectKeyPlatform(nav({ platform: '', userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0)' }))).toBe('mac');
    expect(detectKeyPlatform(nav({ platform: 'Linux x86_64', userAgent: '' }))).toBe('other');
    expect(detectKeyPlatform(undefined)).toBe('other');
  });
});

describe('isRestrictedTarget', () => {
  it('covers text fields, selects, contenteditable, CodeMirror and open dialogs', () => {
    const make = <K extends keyof HTMLElementTagNameMap>(tag: K, props: object = {}) =>
      Object.assign(document.createElement(tag), props);
    expect(isRestrictedTarget(make('input'))).toBe(true);
    expect(isRestrictedTarget(make('input', { type: 'search' }))).toBe(true);
    expect(isRestrictedTarget(make('input', { type: 'range' }))).toBe(false);
    expect(isRestrictedTarget(make('textarea'))).toBe(true);
    expect(isRestrictedTarget(make('select'))).toBe(true);
    expect(isRestrictedTarget(make('button'))).toBe(false);
    const dialog = make('dialog');
    dialog.setAttribute('open', '');
    const inside = make('button');
    dialog.append(inside);
    document.body.append(dialog);
    expect(isRestrictedTarget(inside)).toBe(true);
    const editable = make('div');
    editable.contentEditable = 'true';
    expect(isRestrictedTarget(editable) || editable.isContentEditable === undefined).toBe(true); // jsdom lacks isContentEditable
    expect(isRestrictedTarget(null)).toBe(false);
    expect(isRestrictedTarget(window)).toBe(false);
    dialog.remove();
  });
});

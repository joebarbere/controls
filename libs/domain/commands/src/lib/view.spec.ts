import { z } from 'zod';
import { CommandBus } from './bus';
import { formatConsoleLine } from './console/args';
import { CommandRegistry } from './registry';
import { CONSOLE_AVAILABLE_KEY } from './builtin';
import {
  ViewFocusArgs,
  viewFocusCommand,
  ViewModeArgs,
  viewModeCommand,
  viewNetlistInspectorCommand,
  ViewOverlayArgs,
  viewOverlayCommand,
  viewportCommands,
} from './view';

describe('view.mode and view.focus (F1.7)', () => {
  it('take strict, save-format argument shapes', () => {
    expect(ViewModeArgs.parse({ mode: 'walk' })).toEqual({ mode: 'walk' });
    for (const bad of [{ mode: 'fly' }, {}, { mode: 'work', extra: 1 }]) {
      expect(ViewModeArgs.safeParse(bad).success).toBe(false);
    }
    expect(ViewFocusArgs.parse({ target: 'din-rail-1' })).toEqual({ target: 'din-rail-1' });
    for (const bad of [
      { target: '' },
      { target: 'Din' },
      { target: 'a--b' },
      { target: 'a-' },
      { target: 'x'.repeat(65) },
    ]) {
      expect(ViewFocusArgs.safeParse(bad).success).toBe(false);
    }
    expect(z.toJSONSchema(ViewModeArgs)).toMatchObject({ required: ['mode'] });
    expect(z.toJSONSchema(ViewFocusArgs)).toMatchObject({ required: ['target'] });
  });

  it('are logged view commands: the state and history never change', () => {
    const registry = new CommandRegistry<{ n: number }>().registerAll(viewportCommands());
    const bus = new CommandBus({ registry, initialState: { n: 1 }, tickOf: () => 0 });
    expect(bus.exec('view.mode', { mode: 'walk' }).ok).toBe(true);
    expect(bus.exec('view.focus', { target: 'backplate' }).ok).toBe(true);
    expect(bus.exec('view.mode', { mode: 'run' }).ok).toBe(false);
    expect(bus.state).toEqual({ n: 1 });
    expect(bus.entries.map((e) => [e.id, e.args])).toEqual([
      ['view.mode', { mode: 'walk' }],
      ['view.focus', { target: 'backplate' }],
    ]);
    expect(bus.contextKeys()).toEqual({ 'history.canUndo': false, 'history.canRedo': false });
  });

  it('read naturally as console lines', () => {
    expect(formatConsoleLine('view.mode', { mode: 'work' })).toBe('view.mode --mode work');
    expect(formatConsoleLine('view.focus', { target: 'din-rail-2' })).toBe('view.focus --target din-rail-2');
    expect(viewModeCommand().bindings?.map((b) => b.id)).toEqual(['view.mode.walk', 'view.mode.work']);
    expect(viewFocusCommand().bindings?.map((b) => b.id)).toEqual(['view.focus.selection']);
  });
});

describe('view.overlay (F2.6)', () => {
  it('takes a strict, save-format argument shape', () => {
    expect(ViewOverlayArgs.parse({ name: 'voltage', on: true })).toEqual({ name: 'voltage', on: true });
    for (const bad of [
      { name: 'resistance', on: true },
      { name: 'current' },
      { name: 'current', on: 'yes' },
      { name: 'current', on: true, extra: 1 },
      {},
    ]) {
      expect(ViewOverlayArgs.safeParse(bad).success).toBe(false);
    }
    expect(z.toJSONSchema(ViewOverlayArgs)).toMatchObject({ required: ['name', 'on'], additionalProperties: false });
  });

  it('is a logged view command, offered where the console is, with no default key', () => {
    const def = viewOverlayCommand();
    expect(def.when).toBe(CONSOLE_AVAILABLE_KEY);
    expect(def.logged).toBeUndefined();
    expect(def.keybinding).toBeUndefined();
    expect(def.bindings).toBeUndefined();
    const registry = new CommandRegistry<{ n: number }>().registerAll(viewportCommands());
    const bus = new CommandBus({ registry, initialState: { n: 1 }, tickOf: () => 0 });
    expect(bus.exec('view.overlay', { name: 'current', on: true }).ok).toBe(true);
    expect(bus.exec('view.overlay', { name: 'voltage', on: false }).ok).toBe(true);
    expect(bus.exec('view.overlay', { name: 'heat', on: true }).ok).toBe(false);
    expect(bus.state).toEqual({ n: 1 });
    expect(bus.entries.map((e) => [e.id, e.args])).toEqual([
      ['view.overlay', { name: 'current', on: true }],
      ['view.overlay', { name: 'voltage', on: false }],
    ]);
    expect(bus.contextKeys()).toEqual({ 'history.canUndo': false, 'history.canRedo': false });
  });

  it('reads naturally as a console line', () => {
    expect(formatConsoleLine('view.overlay', { name: 'voltage', on: true })).toBe(
      'view.overlay --name voltage --on true',
    );
  });
});

describe('view.netlistInspector (F2.6)', () => {
  it('is an unlogged view command with no args, offered where the console is, with no default key', () => {
    const def = viewNetlistInspectorCommand();
    expect(def.when).toBe(CONSOLE_AVAILABLE_KEY);
    expect(def.logged).toBe(false);
    expect(def.keybinding).toBeUndefined();
    const registry = new CommandRegistry<{ n: number }>().registerAll(viewportCommands());
    const bus = new CommandBus({ registry, initialState: { n: 1 }, tickOf: () => 0 });
    expect(bus.exec('view.netlistInspector').ok).toBe(true);
    expect(bus.exec('view.netlistInspector', { open: true }).ok).toBe(false);
    expect(bus.state).toEqual({ n: 1 });
    expect(bus.entries).toEqual([]);
  });
});

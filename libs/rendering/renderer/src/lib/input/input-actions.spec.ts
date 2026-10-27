import {
  compileBindings,
  DEFAULT_INPUT_BINDINGS,
  isHeldAction,
  moveIntent,
  rebind,
  type HeldAction,
  type MoveIntent,
} from './input-actions';

describe('input bindings', () => {
  it('defaults are unambiguous and use physical codes for WASD', () => {
    const map = compileBindings(DEFAULT_INPUT_BINDINGS);
    expect(map.get('KeyW')).toBe('moveForward');
    expect(map.get('KeyD')).toBe('moveRight');
    expect(map.get('BracketRight')).toBe('selectNext');
  });

  it('rejects a code bound to two actions', () => {
    expect(() => compileBindings({ ...DEFAULT_INPUT_BINDINGS, moveBack: ['KeyW'] })).toThrow(/KeyW/);
  });

  it('rebind moves a code to the new action and leaves the input untouched', () => {
    const next = rebind(DEFAULT_INPUT_BINDINGS, 'moveForward', ['KeyZ', 'KeyS', 'KeyZ']);
    expect(next.moveForward).toEqual(['KeyZ', 'KeyS']);
    expect(next.moveBack).toEqual(['ArrowDown']);
    expect(DEFAULT_INPUT_BINDINGS.moveBack).toEqual(['KeyS', 'ArrowDown']);
    expect(compileBindings(next).get('KeyS')).toBe('moveForward');
  });

  it('classifies held and triggered actions', () => {
    expect(isHeldAction('sprint')).toBe(true);
    expect(isHeldAction('toggleMode')).toBe(false);
  });
});

describe('moveIntent', () => {
  it('cancels opposite keys and reuses the output object', () => {
    const out: MoveIntent = { forward: 0, strafe: 0, sprint: false };
    const held = new Set<HeldAction>(['moveForward', 'moveBack', 'moveRight', 'sprint']);
    expect(moveIntent(held, out)).toBe(out);
    expect(out).toEqual({ forward: 0, strafe: 1, sprint: true });
    held.delete('moveBack');
    held.add('moveLeft');
    expect(moveIntent(held, out)).toEqual({ forward: 1, strafe: 0, sprint: true });
  });
});

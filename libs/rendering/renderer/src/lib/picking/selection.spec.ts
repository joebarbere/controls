import { SelectionModel, type SelectableInfo, type SelectionSnapshot } from './selection';

const item = (id: string): SelectableInfo => ({ id, kind: 'prop', label: id });

describe('SelectionModel', () => {
  it('cycles in code-unit id order and wraps both ways', () => {
    const m = new SelectionModel();
    m.setSelectables([item('b'), item('a'), item('C')]);
    expect(m.all.map((i) => i.id)).toEqual(['C', 'a', 'b']);
    expect(m.cycle(1)?.id).toBe('C');
    expect(m.cycle(1)?.id).toBe('a');
    expect(m.cycle(1)?.id).toBe('b');
    expect(m.cycle(1)?.id).toBe('C');
    expect(m.cycle(-1)?.id).toBe('b');
    m.select(null);
    expect(m.cycle(-1)?.id).toBe('b');
  });

  it('cycling an empty set does nothing', () => {
    expect(new SelectionModel().cycle(1)).toBeNull();
  });

  it('emits only on change and stops after unsubscribe', () => {
    const m = new SelectionModel();
    m.setSelectables([item('a'), item('b')]);
    const seen: SelectionSnapshot[] = [];
    const off = m.onChange((s) => seen.push(s));
    m.hover('a');
    m.hover('a');
    m.select('b');
    m.select('b');
    expect(m.select('nope')).toBe(false);
    m.hover('nope'); // unknown ids clear the hover
    expect(seen.map((s) => [s.hovered?.id ?? null, s.selected?.id ?? null])).toEqual([
      ['a', null],
      ['a', 'b'],
      [null, 'b'],
    ]);
    off();
    m.select('a');
    expect(seen).toHaveLength(3);
  });

  it('drops hover and selection when their object goes away, and rejects duplicate ids', () => {
    const m = new SelectionModel();
    m.setSelectables([item('a'), item('b')]);
    m.select('a');
    m.hover('b');
    const spy = vi.fn();
    m.onChange(spy);
    m.setSelectables([item('b')]);
    expect(m.selected).toBeNull();
    expect(m.hovered?.id).toBe('b');
    expect(spy).toHaveBeenCalledTimes(1);
    m.setSelectables([item('b')]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(() => m.setSelectables([item('x'), item('x')])).toThrow(/duplicate/);
  });

  it('dispose drops listeners and state', () => {
    const m = new SelectionModel();
    m.setSelectables([item('a')]);
    const spy = vi.fn();
    m.onChange(spy);
    m.dispose();
    m.select('a');
    expect(spy).not.toHaveBeenCalled();
    expect(m.all).toEqual([]);
  });
});

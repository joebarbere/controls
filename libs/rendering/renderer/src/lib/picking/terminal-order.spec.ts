import fc from 'fast-check';
import { BUILTIN_CATALOG } from '@controls/catalog';
import { cycleTerminal, deviceFocusFrame, terminalCycleOrder } from './terminal-order';

const terminalsOf = (id: string) => {
  const def = BUILTIN_CATALOG.device({ id, version: 1 });
  if (!def) throw new Error(`no ${id}`);
  return def.terminals;
};
const t = (id: string, x: number, y: number, z = 0) => ({ id, positionMm: { x, y, z } });

describe('terminalCycleOrder (ADR 0010 decision 4)', () => {
  it('reads top row first, then left to right, then front to back, then by id', () => {
    expect(terminalCycleOrder([t('b', 3, 8), t('a', 3, 40)])).toStrictEqual(['a', 'b']);
    expect(terminalCycleOrder([t('r', 20, 10), t('l', 0, 10), t('top', 50, 30)])).toStrictEqual(['top', 'l', 'r']);
    expect(terminalCycleOrder([t('back', 0, 0, 1), t('front', 0, 0, 9)])).toStrictEqual(['front', 'back']);
    // Same place: code-unit order (`B` < `a`), never locale order.
    expect(terminalCycleOrder([t('a', 0, 0), t('B', 0, 0)])).toStrictEqual(['B', 'a']);
  });

  it('a DIN feed-through block: a (top) then b; the breaker: line (top) then load', () => {
    expect(terminalCycleOrder(terminalsOf('tb.quennick-st4'))).toStrictEqual(['a', 'b']);
    expect(terminalCycleOrder(terminalsOf('breaker.saltmere-1p-15a'))).toStrictEqual(['line', 'load']);
  });

  it('property: independent of the input order', () => {
    const terminal = fc.record({
      id: fc.constantFrom('a', 'b', 'c', 'L1', 'L2', 'N', 'PE'),
      positionMm: fc.record({
        x: fc.integer({ min: 0, max: 5 }),
        y: fc.integer({ min: 0, max: 5 }),
        z: fc.integer({ min: 0, max: 5 }),
      }),
    });
    const lists = fc.uniqueArray(terminal, { selector: (x) => x.id, maxLength: 7 });
    // Every permutation is reachable: a shuffled subarray that keeps every element.
    const withShuffle = lists.chain((list) =>
      fc.tuple(fc.constant(list), fc.shuffledSubarray(list, { minLength: list.length })),
    );
    fc.assert(
      fc.property(withShuffle, ([list, shuffled]) => {
        expect(terminalCycleOrder(shuffled)).toStrictEqual(terminalCycleOrder(list));
      }),
    );
  });
});

describe('cycleTerminal', () => {
  const order = ['a', 'b', 'c'];
  it('steps and wraps both ways', () => {
    expect(cycleTerminal(order, 'a', 1)).toBe('b');
    expect(cycleTerminal(order, 'c', 1)).toBe('a');
    expect(cycleTerminal(order, 'a', -1)).toBe('c');
    expect(cycleTerminal(order, 'b', -1)).toBe('a');
  });
  it('starts at the first (Tab) or the last (Shift+Tab) without a current terminal in the order', () => {
    expect(cycleTerminal(order, null, 1)).toBe('a');
    expect(cycleTerminal(order, null, -1)).toBe('c');
    expect(cycleTerminal(order, 'zz', 1)).toBe('a');
    expect(cycleTerminal([], null, 1)).toBeNull();
  });
});

describe('deviceFocusFrame', () => {
  it('frames a panel device from its front, turned with it', () => {
    expect(deviceFocusFrame({ yaw: 0, pitch: 0, roll: 0 }, 35)).toStrictEqual({ normal: '+z', elevationDeg: 0 });
    expect(deviceFocusFrame({ yaw: 90_000, pitch: 0, roll: 0 }, 35)).toStrictEqual({ normal: '+x', elevationDeg: 0 });
    expect(deviceFocusFrame({ yaw: 180_000, pitch: 0, roll: 0 }, 35)).toStrictEqual({ normal: '-z', elevationDeg: 0 });
    expect(deviceFocusFrame({ yaw: 270_000, pitch: 0, roll: 0 }, 35)).toStrictEqual({ normal: '-x', elevationDeg: 0 });
    // A riser turned about its own front axis still faces front.
    expect(deviceFocusFrame({ yaw: 0, pitch: 0, roll: 90_000 }, 35)).toStrictEqual({ normal: '+z', elevationDeg: 0 });
  });

  it('frames a bench device (front up) from its near side, from above', () => {
    expect(deviceFocusFrame({ yaw: 0, pitch: 270_000, roll: 0 }, 35)).toStrictEqual({ normal: '+z', elevationDeg: 35 });
  });

  it('has no frame facing down or off quarter-turns', () => {
    expect(deviceFocusFrame({ yaw: 0, pitch: 90_000, roll: 0 }, 35)).toBeNull();
    expect(deviceFocusFrame({ yaw: 45_000, pitch: 0, roll: 0 }, 35)).toBeNull();
  });
});

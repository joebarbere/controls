import { NOOP_LIFECYCLE, runFlushes } from './lifecycle';

describe('runFlushes', () => {
  it('calls every flush synchronously and reports success', async () => {
    const a = vi.fn();
    const b = vi.fn(async () => undefined);
    const result = runFlushes([a, b]);
    expect(a).toHaveBeenCalledOnce(); // before any await: pagehide relies on this
    expect(b).toHaveBeenCalledOnce();
    await expect(result).resolves.toBe(true);
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it('waits for all of them even when one throws or rejects, then reports failure', async () => {
    const order: string[] = [];
    const slow = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push('slow');
    };
    const throws = () => {
      throw new Error('sync');
    };
    const rejects = async () => Promise.reject(new Error('async'));
    await expect(runFlushes([throws, rejects, slow])).resolves.toBe(false);
    expect(order).toEqual(['slow']);
  });

  it('is trivially true with nothing registered', async () => {
    await expect(runFlushes([])).resolves.toBe(true);
  });
});

describe('NOOP_LIFECYCLE', () => {
  it('accepts a flush and returns an unregister function', () => {
    const off = NOOP_LIFECYCLE.onBeforeQuit(() => undefined);
    expect(() => off()).not.toThrow();
  });
});

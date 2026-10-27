import { Disposer } from './disposer';

describe('Disposer', () => {
  it('runs tasks once, in reverse order', () => {
    const order: number[] = [];
    const d = new Disposer();
    d.add(() => order.push(1));
    d.add(() => order.push(2));
    d.dispose();
    d.dispose();
    expect(order).toEqual([2, 1]);
    expect(d.disposed).toBe(true);
  });

  it('removes listeners with the same options they were added with', () => {
    const target = new EventTarget();
    const handler = vi.fn();
    const d = new Disposer();
    d.listen(target, 'ping', handler, { capture: true });
    target.dispatchEvent(new Event('ping'));
    d.dispose();
    target.dispatchEvent(new Event('ping'));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('runs every task even when one throws, then rethrows the first error', () => {
    const d = new Disposer();
    const after = vi.fn();
    d.add(after);
    d.add(() => {
      throw new Error('second');
    });
    d.add(() => {
      throw new Error('first');
    });
    expect(() => d.dispose()).toThrow('first');
    expect(after).toHaveBeenCalled();
  });

  it('runs tasks added after dispose immediately', () => {
    const d = new Disposer();
    d.dispose();
    const late = vi.fn();
    d.add(late);
    expect(late).toHaveBeenCalledTimes(1);
  });
});

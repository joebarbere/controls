import { SaveHandleSchema } from '@controls/ipc-contract';
import { randomSaveHandle, SaveHandleTable } from './save-handles';

describe('randomSaveHandle', () => {
  it('produces schema-valid, distinct tokens', () => {
    const tokens = new Set(Array.from({ length: 200 }, randomSaveHandle));
    expect(tokens.size).toBe(200);
    for (const token of tokens) expect(SaveHandleSchema.safeParse(token).success).toBe(true);
  });
});

describe('SaveHandleTable', () => {
  const shop = { kind: 'manual', name: 'Shop' } as const;

  it('resolves a handle only for the window it was issued to', () => {
    const table = new SaveHandleTable();
    const handle = table.issue(1, shop);
    expect(table.resolve(1, handle)).toEqual(shop);
    expect(table.resolve(2, handle)).toBeUndefined();
    expect(table.resolve(1, randomSaveHandle())).toBeUndefined();
  });

  it('gives a save-directory location one stable handle per window, and each pick a fresh one', () => {
    const table = new SaveHandleTable();
    expect(table.issue(1, shop)).toBe(table.issue(1, { kind: 'manual', name: 'Shop' }));
    expect(table.issue(1, shop)).not.toBe(table.issue(2, shop));
    expect(table.issue(1, { kind: 'autosave', slot: 1 })).toBe(table.issue(1, { kind: 'autosave', slot: 1 }));
    const picked = { kind: 'external', path: '/x.ctrl', access: 'read' } as const;
    expect(table.issue(1, picked)).not.toBe(table.issue(1, picked));
  });

  it('re-draws a colliding token', () => {
    const draws = ['AAAAAAAAAAAAAAAAAAAAAA', 'AAAAAAAAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBBBBBBBB'];
    const table = new SaveHandleTable(() => draws.shift() ?? 'CCCCCCCCCCCCCCCCCCCCCC');
    expect(table.issue(1, shop)).toBe('AAAAAAAAAAAAAAAAAAAAAA');
    expect(table.issue(1, { kind: 'manual', name: 'Other' })).toBe('BBBBBBBBBBBBBBBBBBBBBB');
  });

  it('forgets a window’s handles', () => {
    const table = new SaveHandleTable();
    const mine = table.issue(1, shop);
    const theirs = table.issue(2, shop);
    table.forgetOwner(1);
    expect(table.resolve(1, mine)).toBeUndefined();
    expect(table.resolve(2, theirs)).toEqual(shop);
    expect(table.issue(1, shop)).not.toBe(mine);
  });

  it('is bounded: the oldest handle goes first', () => {
    const table = new SaveHandleTable(randomSaveHandle, 2);
    const first = table.issue(1, { kind: 'manual', name: 'A' });
    table.issue(1, { kind: 'manual', name: 'B' });
    table.issue(1, { kind: 'manual', name: 'C' });
    expect(table.size).toBe(2);
    expect(table.resolve(1, first)).toBeUndefined();
    expect(table.issue(1, { kind: 'manual', name: 'A' })).not.toBe(first);
  });
});

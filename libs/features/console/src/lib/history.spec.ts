import { MAX_CONSOLE_HISTORY, MAX_CONSOLE_LINE_LENGTH, Settings, defaultSettings } from '@controls/save-format';
import { appendHistory, HistoryCursor } from './history';

describe('appendHistory', () => {
  it('appends, skipping blanks and a repeat of the newest line', () => {
    let h: readonly string[] = [];
    h = appendHistory(h, 'a');
    h = appendHistory(h, 'a');
    h = appendHistory(h, '   ');
    h = appendHistory(h, 'b');
    h = appendHistory(h, 'a');
    expect(h).toEqual(['a', 'b', 'a']);
  });

  it('keeps the settings caps: 200 lines, 2000 characters, well-formed strings only', () => {
    let h: readonly string[] = [];
    for (let i = 0; i < MAX_CONSOLE_HISTORY + 5; i++) h = appendHistory(h, `line ${i}`);
    expect(h.length).toBe(MAX_CONSOLE_HISTORY);
    expect(h[0]).toBe('line 5');
    const same = appendHistory(h, 'x'.repeat(MAX_CONSOLE_LINE_LENGTH + 1));
    expect(same).toBe(h);
    expect(appendHistory([], 'bad \ud800')).toEqual([]);
    expect(appendHistory([], 'x'.repeat(MAX_CONSOLE_LINE_LENGTH))).toHaveLength(1);
    // The result is always a valid settings document.
    const settings = { ...defaultSettings(), console: { history: [...appendHistory(h, 'ok')] } };
    expect(Settings.safeParse(settings).success).toBe(true);
  });
});

describe('HistoryCursor', () => {
  const history = ['one', 'two', 'three'];

  it('walks back with up, forward with down, and returns the draft past the newest', () => {
    const cursor = new HistoryCursor();
    expect(cursor.down(history)).toBeNull(); // not navigating
    expect(cursor.up(history, 'draft')).toBe('three');
    expect(cursor.up(history, 'three')).toBe('two');
    expect(cursor.up(history, 'two')).toBe('one');
    expect(cursor.up(history, 'one')).toBeNull(); // oldest
    expect(cursor.down(history)).toBe('two');
    expect(cursor.down(history)).toBe('three');
    expect(cursor.down(history)).toBe('draft');
    expect(cursor.down(history)).toBeNull();
  });

  it('does nothing with no history, and reset returns to the draft position', () => {
    const cursor = new HistoryCursor();
    expect(cursor.up([], 'x')).toBeNull();
    cursor.up(history, 'x');
    cursor.reset();
    expect(cursor.up(history, 'y')).toBe('three');
    expect(cursor.down(history)).toBe('y');
  });

  it('copes with the history shrinking under it', () => {
    const cursor = new HistoryCursor();
    cursor.up(history, '');
    cursor.up(history, '');
    expect(cursor.up(['only'], '')).toBe('only');
  });
});

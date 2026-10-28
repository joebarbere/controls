import { fuzzyMatch, fuzzyScore } from './fuzzy';

describe('fuzzyMatch', () => {
  it('matches an ordered, case-insensitive subsequence and reports the positions', () => {
    expect(fuzzyMatch('plo', 'Place object')?.indices).toEqual([0, 1, 6]);
    expect(fuzzyMatch('PLACE', 'Place object')).not.toBeNull();
    expect(fuzzyMatch('xyz', 'Place object')).toBeNull();
    expect(fuzzyMatch('ecalp', 'Place object')).toBeNull();
    expect(fuzzyMatch('longer than the text', 'short')).toBeNull();
  });

  it('matches everything with an empty query', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, indices: [] });
  });

  it('prefers word starts and runs over scattered letters', () => {
    // "ob" at the start of "object" beats the "o" and "b" scattered elsewhere.
    expect(fuzzyMatch('ob', 'Place object')?.indices).toEqual([6, 7]);
    const prefix = fuzzyMatch('und', 'Undo')?.score ?? 0;
    const scattered = fuzzyMatch('und', 'Run a dialog')?.score ?? 0;
    expect(prefix).toBeGreaterThan(scattered);
  });

  it('treats camelCase humps and punctuation as word starts', () => {
    expect(fuzzyMatch('rl', 'view.resetLayout')?.indices).toEqual([5, 10]);
    expect(fuzzyMatch('tp', 'tool-belt pick')?.indices).toEqual([0, 10]);
  });
});

describe('fuzzyScore', () => {
  const fields = (title: string, category: string, id: string) => [
    { text: title, weight: 1 },
    { text: id, weight: 0.8 },
    { text: category, weight: 0.6 },
  ];

  it('needs every word to match some field', () => {
    expect(fuzzyScore('place ent', fields('Place object', 'Entity', 'entity.place'))).not.toBeNull();
    expect(fuzzyScore('place zzz', fields('Place object', 'Entity', 'entity.place'))).toBeNull();
    expect(fuzzyScore('   ', fields('Place object', 'Entity', 'entity.place'))).toBe(0);
  });

  it('searches the id and the category too', () => {
    expect(fuzzyScore('resetLayout', fields('Reset layout', 'View', 'view.resetLayout'))).not.toBeNull();
    expect(fuzzyScore('tool belt', fields('Select tool-belt slot', 'Tool belt', 'toolbelt.select'))).not.toBeNull();
    expect(fuzzyScore('entity', fields('Delete object', 'Entity', 'entity.delete'))).not.toBeNull();
  });

  it('weights a title match above the same match in the category', () => {
    const inTitle = fuzzyScore('view', fields('View thing', 'Other', 'a.b')) ?? 0;
    const inCategory = fuzzyScore('view', fields('Thing', 'View', 'a.b')) ?? 0;
    expect(inTitle).toBeGreaterThan(inCategory);
  });
});

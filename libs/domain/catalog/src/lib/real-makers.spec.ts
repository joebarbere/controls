import { realMakerIn } from '../testing/real-makers';
import { BUILTIN_CATALOG } from './builtin';

/*
 * The realism charter's fictional-brands rule over every catalogue document (devices, cables, tools,
 * accessories, tables): no real maker in a brand, model name, title or source citation. The guard's list
 * (`src/testing/real-makers.ts`) is shared with the content specs that check one family more closely.
 */

type Named = {
  readonly id?: string;
  readonly table?: string;
  readonly brand?: string;
  readonly modelName?: string;
  readonly title?: string;
  readonly sources: readonly { readonly id: string; readonly citation: string }[];
};

const documents: readonly Named[] = [
  ...BUILTIN_CATALOG.devices,
  ...BUILTIN_CATALOG.cables,
  ...BUILTIN_CATALOG.tools,
  ...BUILTIN_CATALOG.accessories,
  ...(BUILTIN_CATALOG.tables as readonly Named[]),
];

describe('no real maker anywhere in the catalogue (realism charter)', () => {
  it('the guard catches a real maker and passes a fictional one', () => {
    expect(realMakerIn('a Square D curve sheet')).toBe('Square D');
    expect(realMakerIn('Saltmere SLM-1P15')).toBeNull();
    expect(realMakerIn('an ideal join')).toBeNull();
  });

  it.each(documents.map((d) => [d.id ?? d.table ?? '?', d] as const))('%s', (_, d) => {
    for (const text of [d.brand, d.modelName, d.title]) if (text !== undefined) expect(realMakerIn(text)).toBeNull();
    for (const s of d.sources) expect([s.id, realMakerIn(s.citation)]).toStrictEqual([s.id, null]);
  });
});

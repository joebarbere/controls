import { checkCoverage, coversPath, SOURCE_PATH_PATTERN } from './sources';
import {
  axesPerpendicular,
  ENTRY_TYPES,
  entryType,
  MOUNT_TYPES,
  mountType,
  TERMINATION_METHODS,
  terminationMethod,
  TOOL_STEPS,
} from './registries';

describe('source coverage paths (catalogue v2)', () => {
  it('a cover covers itself and its descendants; * matches one segment', () => {
    expect(coversPath('sizeMm', 'sizeMm')).toBe(true);
    expect(coversPath('jacket', 'jacket.widthMm')).toBe(true);
    expect(coversPath('jacket.widthMm', 'jacket')).toBe(false);
    expect(coversPath('terminals.*.methods.screw', 'terminals.line.methods.screw.torqueNm')).toBe(true);
    expect(coversPath('terminals.*.methods.screw', 'terminals.line.methods.springCage.torqueNm')).toBe(false);
    expect(coversPath('rows.*.srgb', 'rows.black.srgb')).toBe(true);
    expect(coversPath('model.params.a', 'model.params.ab')).toBe(false);
  });

  it('the bare `terminals` path is the layout: it never covers a termination spec', () => {
    expect(coversPath('terminals', 'terminals')).toBe(true);
    expect(coversPath('terminals', 'terminals.line.methods.screw.torqueNm')).toBe(false);
    expect(coversPath('terminals.line', 'terminals.line.methods.screw.torqueNm')).toBe(true);
  });

  it('path grammar: dotted segments, * anywhere but first', () => {
    for (const ok of [
      'sizeMm',
      'model.params.lengthMm',
      'terminals.*.methods.screw',
      'holes.sol-14',
      'conductors.0',
      'rows.*.srgb',
    ]) {
      expect(SOURCE_PATH_PATTERN.test(ok), ok).toBe(true);
    }
    for (const bad of ['*', '*.x', 'a..b', '.a', 'a.', 'a b', 'a.**'])
      expect(SOURCE_PATH_PATTERN.test(bad), bad).toBe(false);
  });

  it('checkCoverage: uncovered paths, covers of nothing, duplicate ids', () => {
    const s = (id: string, covers: string[]) => ({ id, kind: 'game-design' as const, citation: 'x', covers });
    expect(checkCoverage([s('a', ['x', 'y'])], ['x', 'y'])).toStrictEqual([]);
    expect(checkCoverage([s('a', ['x']), s('a', ['z'])], ['x', 'y'])).toStrictEqual([
      { path: 'sources', message: 'Source ids must be unique' },
      { path: 'y', message: 'Has no source (realism charter: every value has a source)' },
      { path: 'sources', message: "A source covers z, which the entry doesn't have" },
    ]);
  });
});

describe('catalogue v2 registries', () => {
  it('rows are keyed by their own id and looked up as own properties only', () => {
    for (const [registry, lookup] of [
      [TERMINATION_METHODS, terminationMethod],
      [MOUNT_TYPES, mountType],
      [ENTRY_TYPES, entryType],
    ] as const) {
      for (const [id, row] of Object.entries(registry)) {
        expect(row.id).toBe(id);
        expect(lookup(id)).toBe(row);
        expect(row.source.length).toBeGreaterThan(20);
        if (row.kind === 'game-design') expect(row.source).toMatch(/^game-design/);
      }
      expect(lookup('toString')).toBeUndefined();
      expect(Object.isFrozen(registry)).toBe(true);
    }
  });

  it('pins the P3 ids (save format once a save names them)', () => {
    expect(Object.keys(TERMINATION_METHODS)).toStrictEqual(['screw', 'springCage', 'backStab', 'twistOn']);
    expect(Object.keys(MOUNT_TYPES)).toStrictEqual(['din35', 'backplate', 'deviceYoke', 'studFlange']);
    expect(Object.keys(ENTRY_TYPES)).toStrictEqual(['knockout', 'pryout', 'clamp', 'drillSite']);
    expect(
      Object.values(TERMINATION_METHODS)
        .filter((m) => m.clampTorque)
        .map((m) => m.id),
    ).toStrictEqual(['screw']);
  });

  it('every entry type opens with at least one real tool step', () => {
    for (const type of Object.values(ENTRY_TYPES)) {
      expect(type.opens.length).toBeGreaterThan(0);
      for (const step of type.opens) expect(TOOL_STEPS).toContain(step);
    }
  });

  it('perpendicular axes', () => {
    expect(axesPerpendicular('+x', '+z')).toBe(true);
    expect(axesPerpendicular('+x', '-x')).toBe(false);
    expect(axesPerpendicular('+y', '+y')).toBe(false);
  });
});

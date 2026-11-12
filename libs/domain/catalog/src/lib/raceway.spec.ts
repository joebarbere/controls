import { BUILTIN_CATALOG } from './builtin';
import { parseCatalog } from './catalog';
import type { DeviceDefinition } from './device';
import {
  conduitTradeSize,
  cutLengthMm,
  deviceBodySizeMm,
  deviceMountWidthMm,
  isCutToLength,
  racewayEntryProblems,
  racewayOf,
  racewayPorts,
} from './raceway';

/*
 * F3.5 part 2: the raceway geometry the commands, the placement maths and the recipes share (body
 * size from the cut length, conduit ends on the body box's faces) and the load-time rules of the
 * entries and the new `crossMm` and category fields.
 */

const device = (id: string): DeviceDefinition => {
  const d = BUILTIN_CATALOG.device({ id, version: 1 });
  if (!d) throw new Error(`no ${id}`);
  return d;
};

const DUCT = 'duct.lattisby-40x60';
const STICK = 'emt.stavenor-075';

describe('raceway geometry', () => {
  it('a cut part’s body is its cut length wide; a new one is its entry’s default', () => {
    const duct = device(DUCT);
    expect(isCutToLength(duct)).toBe(true);
    expect(racewayOf(duct)).toBe('duct');
    expect(cutLengthMm(duct, null)).toBe(300);
    expect(deviceBodySizeMm(duct, null)).toStrictEqual({ widthMm: 300, heightMm: 40, depthMm: 60 });
    expect(deviceBodySizeMm(duct, { lengthMm: 125, coverOn: false })).toStrictEqual({
      widthMm: 125,
      heightMm: 40,
      depthMm: 60,
    });
    expect(deviceMountWidthMm(duct, 'backplate', { lengthMm: 125 })).toBe(125);
    expect(deviceMountWidthMm(duct, 'din35', null)).toBeUndefined();
  });

  it('everything else keeps its catalogue size and fit width', () => {
    const breaker = device('breaker.saltmere-1p-15a');
    expect(isCutToLength(breaker)).toBe(false);
    expect(racewayOf(breaker)).toBeNull();
    expect(cutLengthMm(breaker, { lengthMm: 5 })).toBeNull();
    expect(deviceBodySizeMm(breaker, null)).toBe(breaker.sizeMm);
    expect(deviceMountWidthMm(breaker, 'din35', null)).toBe(40);
    const elbow = device('elbow.stavenor-emt-050');
    expect([racewayOf(elbow), isCutToLength(elbow)]).toStrictEqual(['conduit', false]);
  });

  it('conduit trade sizes come from tradeSizeIn; ducts and devices have none', () => {
    expect(conduitTradeSize(device('connector.stavenor-emt-050'))).toBe('1/2');
    expect(conduitTradeSize(device(STICK))).toBe('3/4');
    expect(conduitTradeSize(device('elbow.stavenor-emt-100'))).toBe('1');
    expect(conduitTradeSize(device(DUCT))).toBeNull();
    expect(conduitTradeSize(device('tb.quennick-st4'))).toBeNull();
  });

  it('puts every conduit end on a face of its body box, centred on the tube', () => {
    // A 3/4 stick cut to 750 mm: D = 24, r = 12.
    expect(racewayPorts(device(STICK), { lengthMm: 750 })).toStrictEqual([
      { id: 'a', kind: 'joint', positionMm: { x: 0, y: 12, z: 12 }, axis: '-x' },
      { id: 'b', kind: 'joint', positionMm: { x: 750, y: 12, z: 12 }, axis: '+x' },
    ]);
    // A 1/2 elbow: R = 105, r = 9, box 114 square.
    expect(racewayPorts(device('elbow.stavenor-emt-050'), null)).toStrictEqual([
      { id: 'a', kind: 'joint', positionMm: { x: 9, y: 0, z: 9 }, axis: '-y' },
      { id: 'b', kind: 'joint', positionMm: { x: 114, y: 105, z: 9 }, axis: '+x' },
    ]);
    // A 1 in connector: a 28 mm body, 42 mm across (r = 21).
    expect(racewayPorts(device('connector.stavenor-emt-100'), null)).toStrictEqual([
      { id: 'a', kind: 'entry', positionMm: { x: 0, y: 21, z: 21 }, axis: '-x' },
      { id: 'b', kind: 'joint', positionMm: { x: 28, y: 21, z: 21 }, axis: '+x' },
    ]);
    expect(racewayPorts(device(DUCT), null)).toStrictEqual([]);
    expect(racewayPorts(device('tb.quennick-st4'), null)).toStrictEqual([]);
  });

  it('every built-in raceway entry passes its geometry rules', () => {
    for (const d of BUILTIN_CATALOG.devices) expect(racewayEntryProblems(d), d.id).toStrictEqual([]);
  });
});

describe('the raceway and terminal-block load rules', () => {
  const tables = BUILTIN_CATALOG.tables;
  const parse = (entry: unknown) => parseCatalog(2, { devices: [entry], tables });
  const clone = (id: string): Record<string, unknown> =>
    structuredClone(device(id)) as unknown as Record<string, unknown>;
  const messages = (entry: unknown): string[] => {
    const result = parse(entry);
    return result.ok ? [] : result.issues.map((i) => i.message);
  };

  it('accepts the built-in entries one by one', () => {
    for (const id of [DUCT, STICK, 'elbow.stavenor-emt-075', 'tb.quennick-sc25'])
      expect(messages(clone(id))).toEqual([]);
  });

  it('refuses a default length past the stock, or a minimum above the default', () => {
    const long = clone(DUCT);
    (long['model'] as { params: Record<string, number> }).params['defaultLengthMm'] = 2500;
    expect(messages(long)).toContain('defaultLengthMm must not exceed the stock length (sizeMm.widthMm)');
    const short = clone(DUCT);
    (short['model'] as { params: Record<string, number> }).params['minLengthMm'] = 400;
    expect(messages(short).join()).toMatch(/minLengthMm must not exceed defaultLengthMm/);
  });

  it('refuses a conduit body that isn’t the even-rounded tube, and an elbow box that isn’t R + D/2', () => {
    const odd = clone(STICK);
    odd['sizeMm'] = { widthMm: 3048, heightMm: 23, depthMm: 23 };
    expect(messages(odd).join()).toMatch(/rounded up to an even whole mm/);
    const elbow = clone('elbow.stavenor-emt-075');
    elbow['sizeMm'] = { widthMm: 130, heightMm: 132, depthMm: 24 };
    expect(messages(elbow).join()).toMatch(/bend radius plus half its depth/);
    const bad = clone(STICK);
    (bad['model'] as { params: Record<string, number> }).params['tradeSizeIn'] = 0.6;
    expect(messages(bad).join()).toMatch(/tradeSizeIn must be a trade size/);
  });

  it('refuses a crossMm on a mount that isn’t linear, and categories on the wrong kinds', () => {
    const duct = clone(DUCT);
    duct['mounts'] = [{ type: 'backplate', widthMm: 2000, crossMm: 5 }];
    expect(messages(duct).join()).toMatch(/crossMm places a device across a linear mount only/);
    const block = clone('tb.quennick-st4');
    block['category'] = 'raceway';
    expect(messages(block).join()).toMatch(/Category "raceway" goes with raceway kinds/);
    const stick = clone(STICK);
    stick['category'] = 'terminalBlock';
    expect(messages(stick).join()).toMatch(/Category "terminalBlock" goes with the terminalBlock/);
  });
});

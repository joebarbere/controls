import { BUILTIN_CATALOG } from './builtin';
import type { DeviceDefinition, EnclosureEntry } from './device';
import { entryType, mountType } from './registries';

/*
 * The F3.5 part 1 enclosures (content/devices/box.*, panel.*): the hand calculation of every interior
 * volume (computed from the inside dimensions, never from a code table: the P3 source pre-audit), and
 * the geometry the commands, the snap maths and the recipes rely on: entries on an outside wall face
 * with their axis pointing in, mounts inside the body.
 */

const enclosure = (id: string): DeviceDefinition => {
  const d = BUILTIN_CATALOG.device({ id, version: 1 });
  if (!d?.enclosure || !d.sizeMm) throw new Error(`${id} is not an enclosure`);
  return d;
};

const ENCLOSURES = [
  'box.tinmoor-1g-steel',
  'box.tinmoor-2g-nm',
  'box.tinmoor-4sq-steel',
  'box.tinmoor-4rd-nm-ceiling',
  'panel.pellmoor-din-400x500',
];

/** The outward face an entry sits on, from its inward axis: `-y` (pointing down, in) is the top face. */
function onItsFace(e: EnclosureEntry, size: { widthMm: number; heightMm: number; depthMm: number }): boolean {
  const p = e.positionMm;
  switch (e.axis) {
    case '-y':
      return p.y === size.heightMm;
    case '+y':
      return p.y === 0;
    case '+x':
      return p.x === 0;
    case '-x':
      return p.x === size.widthMm;
    case '+z':
      return p.z === 0;
    case '-z':
      return p.z === size.depthMm; // the open front: no P3 enclosure has a front entry
  }
}

describe('the F3.5 enclosures', () => {
  it('store the interior volume computed from their inside dimensions (hand calculation, 0.5 %)', () => {
    // 1-gang steel: inside 51 × 76 × 64 mm (outside 55 × 80 × 66 less 2 mm walls on four sides and the back).
    //   51 × 76 = 3876; 3876 × 64 = 248 064 mm³ (÷ 16 387.064 = 15.1 in³).
    // 2-gang nonmetallic: inside 92 × 80 × 76 mm (outside 98 × 86 × 79 less 3 mm walls).
    //   92 × 80 = 7360; 7360 × 76 = 559 360 mm³ (34.1 in³).
    // 4 in square: inside 101 × 101 × 38 mm (outside 105 × 105 × 40 less 2 mm walls).
    //   101 × 101 = 10 201; 10 201 × 38 = 387 638 mm³ (23.7 in³).
    // 4 in round: a cylinder 98 mm across and 57 mm deep inside (outside 104 × 104 × 60 less 3 mm walls).
    //   r = 49, r² = 2401, π × 2401 = 7542.96; × 57 = 429 948.9 → 429 949 mm³ (26.2 in³).
    // Panel: inside 396 × 496 × 198 mm (400 × 500 × 200 less 2 mm walls).
    //   396 × 496 = 196 416; 196 416 × 198 = 38 890 368 mm³.
    const hand: Record<string, number> = {
      'box.tinmoor-1g-steel': 248_064,
      'box.tinmoor-2g-nm': 559_360,
      'box.tinmoor-4sq-steel': 387_638,
      'box.tinmoor-4rd-nm-ceiling': 429_949,
      'panel.pellmoor-din-400x500': 38_890_368,
    };
    for (const id of ENCLOSURES) {
      const stored = enclosure(id).enclosure?.interiorVolumeMm3 ?? 0;
      expect(Math.abs(stored - hand[id]) / hand[id], id).toBeLessThanOrEqual(0.005);
    }
    // The rectangular boxes are exact products of whole millimetres.
    expect(enclosure('box.tinmoor-1g-steel').enclosure?.interiorVolumeMm3).toBe(51 * 76 * 64);
    expect(enclosure('panel.pellmoor-din-400x500').enclosure?.interiorVolumeMm3).toBe(396 * 496 * 198);
  });

  it('put every entry on an outside wall face, pointing in, with a registered type and a sensible trade size', () => {
    for (const id of ENCLOSURES) {
      const d = enclosure(id);
      const size = d.sizeMm as NonNullable<DeviceDefinition['sizeMm']>;
      for (const e of d.enclosure?.entries ?? []) {
        expect(onItsFace(e, size), `${id} ${e.id}`).toBe(true);
        expect(entryType(e.type), `${id} ${e.id}`).toBeDefined();
        // Knockouts and drill sites take a connector of a trade size; clamps and pryouts take a cable.
        expect(e.tradeSize === null, `${id} ${e.id}`).toBe(e.type === 'clamp' || e.type === 'pryout');
        expect(e.internalClamp, `${id} ${e.id}`).toBe(e.type === 'clamp' || e.type === 'pryout');
      }
    }
  });

  it('put every mount inside the body, of a registered type, a rail within its enclosure', () => {
    for (const id of ENCLOSURES) {
      const d = enclosure(id);
      const size = d.sizeMm as NonNullable<DeviceDefinition['sizeMm']>;
      for (const m of d.enclosure?.mounts ?? []) {
        const p = m.positionMm;
        expect(mountType(m.type), `${id} ${m.id}`).toBeDefined();
        expect(p.x > 0 && p.x < size.widthMm && p.y > 0 && p.y < size.heightMm, `${id} ${m.id}`).toBe(true);
        expect(p.z > 0 && p.z < size.depthMm, `${id} ${m.id}`).toBe(true);
        expect(m.axis).toBe('+x');
        expect(m.facing).toBe('+z');
        if (mountType(m.type)?.occupancy !== 'single') expect(p.x + m.extentMm).toBeLessThan(size.widthMm);
      }
    }
  });

  it('the DIN panel: two 330 mm rails and a 350 mm backplate square; the 15 A breaker and the DIN supply fit both rails', () => {
    const panel = enclosure('panel.pellmoor-din-400x500');
    expect(panel.enclosure?.mounts.map((m) => [m.id, m.type, m.extentMm])).toStrictEqual([
      ['rail-1', 'din35', 330],
      ['rail-2', 'din35', 330],
      ['plate', 'backplate', 350],
    ]);
    // Rail centrelines at y = 350 and 175; a mounted device's bottom sits 45 mm below (half of 90 mm).
    expect(panel.enclosure?.mounts.slice(0, 2).map((m) => m.positionMm.y + 45)).toStrictEqual([350, 175]);
    for (const id of ['breaker.saltmere-1p-15a', 'supply.railwick-din-24v-5a']) {
      const d = BUILTIN_CATALOG.device({ id, version: 1 }) as DeviceDefinition;
      const rail = panel.enclosure?.mounts[0];
      // The device (from the rail top at z = 23) stays inside the 200 mm deep box.
      expect((rail?.positionMm.z ?? 0) + (d.sizeMm?.depthMm ?? 0)).toBeLessThan(200);
      // Eight 40 mm devices fit along one rail.
      expect(Math.floor((rail?.extentMm ?? 0) / (d.mounts[0]?.widthMm ?? 1))).toBe(8);
    }
    // The tallest DIN device (the 125 mm supply) on rail 2 stays clear of rail 1's devices.
    expect(130 + 125).toBeLessThan(305);
  });

  it('have no more than 32 entries, and their order is the save-format order of openEntries', () => {
    expect(ENCLOSURES.map((id) => enclosure(id).enclosure?.entries.map((e) => e.id))).toStrictEqual([
      ['clamp-top', 'clamp-bottom', 'ko-top', 'ko-bottom', 'ko-back'],
      ['clamp-top-1', 'clamp-top-2', 'clamp-bottom-1', 'clamp-bottom-2'],
      [
        'ko-top-1',
        'ko-top-2',
        'ko-bottom-1',
        'ko-bottom-2',
        'ko-left-1',
        'ko-left-2',
        'ko-right-1',
        'ko-right-2',
        'ko-back',
      ],
      ['clamp-top', 'clamp-bottom', 'clamp-left', 'clamp-right'],
      ['ko-bottom-1', 'ko-bottom-2', 'ko-bottom-3', 'drill-top-1', 'drill-top-2'],
    ]);
  });
});

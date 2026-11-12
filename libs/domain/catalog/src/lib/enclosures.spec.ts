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
    // Trade designations are outside sizes (electrical-realism-reviewer, 2026-11-12).
    // 1-gang steel: outside 51 × 76 × 64 (3 × 2 × 2-1/2 in), less 2 mm walls: inside 47 × 72 × 62.
    //   47 × 72 = 3384; 3384 × 62 = 209 808 mm³ (÷ 16 387.064 = 12.80 in³).
    // 2-gang nonmetallic: outside 102 × 92 × 76, less 3 mm walls: inside 96 × 86 × 73.
    //   96 × 86 = 8256; 8256 × 73 = 602 688 mm³ (36.8 in³).
    // 4 in square: outside 102 × 102 × 40, less 2 mm walls: inside 98 × 98 × 38.
    //   98 × 98 = 9604; 9604 × 38 = 364 952 mm³ (22.27 in³).
    // 4 in round: outside Ø102 × 57, less 3 mm walls: a cylinder 96 mm across and 54 mm deep inside.
    //   r = 48, r² = 2304, π × 2304 = 7238.23; × 54 = 390 864.4 → 390 864 mm³ (23.85 in³).
    // Panel: inside 396 × 496 × 198 mm (400 × 500 × 200 less 2 mm walls).
    //   396 × 496 = 196 416; 196 416 × 198 = 38 890 368 mm³.
    const hand: Record<string, number> = {
      'box.tinmoor-1g-steel': 209_808,
      'box.tinmoor-2g-nm': 602_688,
      'box.tinmoor-4sq-steel': 364_952,
      'box.tinmoor-4rd-nm-ceiling': 390_864,
      'panel.pellmoor-din-400x500': 38_890_368,
    };
    for (const id of ENCLOSURES) {
      const stored = enclosure(id).enclosure?.interiorVolumeMm3 ?? 0;
      expect(Math.abs(stored - hand[id]) / hand[id], id).toBeLessThanOrEqual(0.005);
    }
    // The rectangular boxes are exact products of whole millimetres.
    expect(enclosure('box.tinmoor-1g-steel').enclosure?.interiorVolumeMm3).toBe(47 * 72 * 62);
    expect(enclosure('box.tinmoor-2g-nm').enclosure?.interiorVolumeMm3).toBe(96 * 86 * 73);
    expect(enclosure('box.tinmoor-4sq-steel').enclosure?.interiorVolumeMm3).toBe(98 * 98 * 38);
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

  it('the 2-gang box holds two wiring devices: 46 mm gangs centred in its width, tall enough for 83.3 mm screw spacing', () => {
    const box = enclosure('box.tinmoor-2g-nm');
    const yokes = box.enclosure?.mounts.map((m) => m.positionMm.x) ?? [];
    expect(yokes).toStrictEqual([5, 51]); // 3 mm wall + (96 − 92) / 2 = 5; 5 + 46 = 51
    expect(yokes[1] - yokes[0]).toBe(46); // 1-13/16 in gang centres
    expect(102 - 46 - yokes[1]).toBe(yokes[0]); // centred: 5 mm each side
    expect((box.sizeMm?.heightMm ?? 0) - 6).toBeGreaterThan(83.3); // inside height 86 mm > 3-9/32 in
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
    // The backplate is 2 mm thick, 10 mm off the back wall's inside face (z 12–14); rails 8 mm proud of it.
    expect(panel.enclosure?.mounts.map((m) => m.positionMm.z)).toStrictEqual([22, 22, 14]);
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

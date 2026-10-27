import { ExtrudeGeometry, Matrix4, Shape, type BufferGeometry } from 'three/webgpu';
import { mm } from './units';

/** Top-hat rail cross-section per EN 60715 TS 35×7.5 (1 mm steel). */
export const DIN_RAIL_TS35 = { widthMm: 35, heightMm: 7.5, crownWidthMm: 27, thicknessMm: 1 } as const;

/**
 * TS35×7.5 DIN rail of the given length.
 * Orientation: rail runs along +X, the 35 mm width spans Y, the 7.5 mm height stands off the
 * backplate along +Z; the back of the rail sits at z = 0. Centred on X and Y.
 */
export function buildDinRailGeometry(lengthMm: number): BufferGeometry {
  const { widthMm, heightMm, crownWidthMm, thicknessMm: t } = DIN_RAIL_TS35;
  const w = widthMm / 2;
  const c = crownWidthMm / 2;
  const h = heightMm;
  // Profile in (x = across width, y = stand-off), traced around the 1 mm sheet.
  const profile: Array<[number, number]> = [
    [-c, 0],
    [c, 0],
    [c, h - t],
    [w, h - t],
    [w, h],
    [c - t, h],
    [c - t, t],
    [-(c - t), t],
    [-(c - t), h],
    [-w, h],
    [-w, h - t],
    [-c, h - t],
  ];
  const shape = new Shape();
  profile.forEach(([x, y], i) => (i === 0 ? shape.moveTo(mm(x), mm(y)) : shape.lineTo(mm(x), mm(y))));
  shape.closePath();

  const geometry = new ExtrudeGeometry(shape, { depth: mm(lengthMm), bevelEnabled: false });
  geometry.translate(0, 0, -mm(lengthMm) / 2);
  // Cyclic axis permutation (a proper rotation): extrude axis → X, width → Y, stand-off → Z.
  geometry.applyMatrix4(new Matrix4().set(0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1));
  geometry.computeVertexNormals();
  return geometry;
}

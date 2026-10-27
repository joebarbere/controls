import { Box3, Vector3, type BufferGeometry } from 'three/webgpu';
import { buildBackplateGeometry } from './backplate';
import { buildDinRailGeometry, DIN_RAIL_TS35 } from './din-rail';

const box = (g: BufferGeometry): Box3 => {
  g.computeBoundingBox();
  if (!g.boundingBox) throw new Error('no bounding box');
  return g.boundingBox;
};
const size = (g: BufferGeometry) => box(g).getSize(new Vector3());

describe('buildDinRailGeometry', () => {
  it('is a TS35×7.5 profile running along X', () => {
    const s = size(buildDinRailGeometry(500));
    expect(s.x).toBeCloseTo(0.5, 6);
    expect(s.y).toBeCloseTo(DIN_RAIL_TS35.widthMm / 1000, 6);
    expect(s.z).toBeCloseTo(DIN_RAIL_TS35.heightMm / 1000, 6);
  });

  it('sits on the backplate (back face at z = 0)', () => {
    expect(box(buildDinRailGeometry(100)).min.z).toBeCloseTo(0, 9);
  });
});

describe('buildBackplateGeometry', () => {
  it('has its front face at z = 0', () => {
    const g = buildBackplateGeometry(600, 800);
    expect(box(g).max.z).toBeCloseTo(0, 9);
    expect(size(g).x).toBeCloseTo(0.6, 6);
  });
});

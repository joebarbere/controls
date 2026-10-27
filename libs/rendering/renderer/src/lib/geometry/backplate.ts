import { BoxGeometry, type BufferGeometry } from 'three/webgpu';
import { mm } from '@controls/units';

/** Panel backplate (sub-panel). Front face at z = 0, extends to z = −thickness. Centred on X/Y. */
export function buildBackplateGeometry(widthMm: number, heightMm: number, thicknessMm = 2.5): BufferGeometry {
  const geometry = new BoxGeometry(mm(widthMm), mm(heightMm), mm(thicknessMm));
  geometry.translate(0, 0, -mm(thicknessMm) / 2);
  return geometry;
}

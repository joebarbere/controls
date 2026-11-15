import fc from 'fast-check';
import { BufferAttribute, CylinderGeometry, Group, MeshBasicMaterial, type BufferGeometry } from 'three/webgpu';
import { InstancedPool } from './instanced-pool';

/** A pool on a fresh group, recording every geometry it builds. */
const pool = (options: { minCapacity?: number; shrink?: boolean } = {}) => {
  const parent = new Group();
  const material = new MeshBasicMaterial();
  const materialDispose = vi.spyOn(material, 'dispose');
  const geometries: BufferGeometry[] = [];
  const p = new InstancedPool(
    'pool',
    () => {
      const g = new CylinderGeometry(1, 1, 1, 6, 1);
      geometries.push(g);
      return g;
    },
    material,
    parent,
    { unpickable: false, ...options },
  );
  return { p, parent, material, materialDispose, geometries };
};

const isPowerOfTwoMultiple = (capacity: number, min: number) => Number.isInteger(Math.log2(capacity / min));

let updateRange: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  updateRange = vi.spyOn(BufferAttribute.prototype, 'addUpdateRange');
});
afterEach(() => {
  expect(updateRange).not.toHaveBeenCalled();
  updateRange.mockRestore();
});

describe('InstancedPool', () => {
  it('property: capacity fits every count, stays a power-of-two multiple of the minimum, and never leaks a mesh', () => {
    fc.assert(
      fc.property(
        fc.array(fc.nat({ max: 5000 }), { minLength: 1, maxLength: 30 }),
        fc.constantFrom(1, 16, 64),
        (counts, min) => {
          const { p, parent, materialDispose } = pool({ minCapacity: min, shrink: true });
          const replaced: { mesh: unknown; disposed: () => number; geometryDisposed: () => number }[] = [];
          for (const count of counts) {
            const before = p.mesh;
            let disposed = 0;
            let geometryDisposed = 0;
            before.addEventListener('dispose', () => disposed++);
            before.geometry.addEventListener('dispose', () => geometryDisposed++);
            const rebuilt = p.ensure(count);
            expect(rebuilt).toBe(p.mesh !== before);
            if (rebuilt)
              replaced.push({ mesh: before, disposed: () => disposed, geometryDisposed: () => geometryDisposed });
            expect(p.capacity).toBeGreaterThanOrEqual(count);
            expect(p.capacity).toBeLessThan(4 * Math.max(count, min));
            expect(isPowerOfTwoMultiple(p.capacity, min)).toBe(true);
            expect(p.mesh.count).toBe(count);
          }
          for (const r of replaced) {
            expect(r.disposed()).toBe(1);
            expect(r.geometryDisposed()).toBe(1);
            expect(parent.children).not.toContain(r.mesh);
          }
          expect(parent.children).toStrictEqual([p.mesh]);
          expect(materialDispose).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 60 },
    );
  });

  it('rebuilds at most twice going back and forth across the 64 / 65 boundary', () => {
    const { p, geometries } = pool({ minCapacity: 64, shrink: true });
    for (let i = 0; i < 10; i++) {
      p.ensure(65);
      p.ensure(64);
    }
    expect(geometries.length - 1).toBeLessThanOrEqual(2);
  });

  it('carries visibility and userData over to a rebuilt mesh', () => {
    const { p } = pool();
    p.mesh.visible = false;
    p.mesh.userData['wires'] = { look: 'x', instances: 0 };
    expect(p.ensure(100)).toBe(true);
    expect(p.mesh.visible).toBe(false);
    expect(p.mesh.userData['wires']).toStrictEqual({ look: 'x', instances: 0 });
  });

  it('documents the shrink floor: a pool at twice its minimum stays there, even empty', () => {
    const { p } = pool({ minCapacity: 64, shrink: true });
    p.ensure(100);
    expect(p.capacity).toBe(128);
    p.ensure(0);
    expect(p.capacity).toBe(128); // a quarter (32) would be below the floor, so it stays
    p.ensure(200);
    p.ensure(0);
    expect(p.capacity).toBe(64); // 256 → 64
  });

  it('dispose frees the mesh and its own geometry, never the shared material', () => {
    const { p, parent, materialDispose, geometries } = pool();
    const dispose = vi.spyOn(p.mesh, 'dispose');
    const geometry = vi.spyOn(geometries[0], 'dispose');
    p.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(geometry).toHaveBeenCalledTimes(1);
    expect(parent.children).toHaveLength(0);
    expect(materialDispose).not.toHaveBeenCalled();
  });
});

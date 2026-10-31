/**
 * Disjoint sets over `0 … size − 1` (union by size, path halving), on preallocated typed arrays. The
 * compiler never uses a root as an identity: it numbers sets by their smallest member, so the union
 * order can't leak into the netlist. {@link UnionFind.reset} reuses the arrays for another size, so a
 * compiler that keeps one allocates nothing per recompile once it has seen its largest plant.
 */
export class UnionFind {
  private parent: Int32Array;
  private size: Int32Array;

  constructor(count: number) {
    this.parent = new Int32Array(count);
    this.size = new Int32Array(count);
    this.reset(count);
  }

  /** Makes `0 … count − 1` singletons again, growing the arrays if `count` is larger than before. */
  reset(count: number): void {
    if (this.parent.length < count) {
      const capacity = Math.max(count, 2 * this.parent.length);
      this.parent = new Int32Array(capacity);
      this.size = new Int32Array(capacity);
    }
    const parent = this.parent;
    for (let i = 0; i < count; i++) parent[i] = i;
    this.size.fill(1, 0, count);
  }

  find(x: number): number {
    const parent = this.parent;
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }

  union(x: number, y: number): void {
    let rx = this.find(x);
    let ry = this.find(y);
    if (rx === ry) return;
    if (this.size[rx] < this.size[ry]) [rx, ry] = [ry, rx];
    this.parent[ry] = rx;
    this.size[rx] += this.size[ry];
  }
}

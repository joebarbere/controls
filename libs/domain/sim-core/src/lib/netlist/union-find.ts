/**
 * Disjoint sets over `0 … size − 1` (union by size, path halving), on preallocated typed arrays. The
 * compiler never uses a root as an identity: it numbers sets by their smallest member, so the union
 * order can't leak into the netlist.
 */
export class UnionFind {
  private readonly parent: Int32Array;
  private readonly size: Int32Array;

  constructor(count: number) {
    this.parent = new Int32Array(count);
    this.size = new Int32Array(count).fill(1);
    for (let i = 0; i < count; i++) this.parent[i] = i;
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

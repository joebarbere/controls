import { runBenchCase } from './bench';
import { SNAPSHOT_READ_CASE } from './cases';
import { bytesPerRead, READ_ALLOCATION_GATE_BYTES, READ_PLANT, snapshotReadRig } from './snapshot-read';

/*
 * The per-frame snapshot read's bench case (plan F2.3b, #60 review): every frame's read is a real
 * copy, it allocates nothing, and the allocation gate fails a read that does allocate.
 */

describe('the snapshot read bench case', () => {
  it('copies a fresh slot every frame and reads every device field', () => {
    const rig = snapshotReadRig();
    rig.announce();
    rig.read();
    const first = rig.sum();
    rig.announce();
    rig.read();
    expect(rig.sum()).toBe(first);
    expect(first).toBeGreaterThan(0);
    expect(() => rig.read()).toThrow(/copied nothing/); // no publish announced: nothing new
  });

  it('the gate bites: a read that allocates is measured and fails the case', () => {
    const rig = snapshotReadRig();
    const kept: number[][] = [];
    const leaky = {
      announce: () => rig.announce(),
      read: () => {
        rig.read();
        kept[0] = new Array(8).fill(1); // a planted allocation per read
      },
      sum: () => rig.sum(),
    };
    expect(bytesPerRead(leaky, 5_000, 4)).toBeGreaterThan(8 * READ_ALLOCATION_GATE_BYTES);
  });

  it('runs as a bench case: deterministic, reported with p50 and p99, and gated on allocation: a read allocates nothing', () => {
    const result = runBenchCase({ ...SNAPSHOT_READ_CASE, warmup: 50, runs: 200 }, () => 0);
    expect(result.ok).toBe(true);
    expect(result.deterministic).toBe(true);
    expect(result.budgetMs).toBeNull();
    expect(result.invariant?.failure).toBeNull();
    expect(result.invariant?.value).toBeLessThan(READ_ALLOCATION_GATE_BYTES);
    expect(result.p99Ms).toBeGreaterThanOrEqual(result.medianMs);
    expect(READ_PLANT.devices).toBe(500);
  });
});

import { bytesPerRead, READ_ALLOCATION_GATE_BYTES, READ_PLANT, snapshotReadRig } from './snapshot-read';

/*
 * The per-frame snapshot read's rig and allocation measure (plan F2.3b, #60 review): every frame's
 * read is a real copy, it allocates nothing, and the measure catches a read that does. The full case,
 * with its p50/p99 and the gate at full size, runs in `sim bench` (the `bench` target in `verify`).
 */

describe('the snapshot read rig', () => {
  it('copies a fresh slot every frame and reads every device field', () => {
    const rig = snapshotReadRig();
    rig.announce();
    rig.read();
    const first = rig.sum();
    rig.announce();
    rig.read();
    expect(rig.sum()).toBe(first);
    expect(first).toBeGreaterThan(0);
    expect(READ_PLANT.devices).toBe(500);
    expect(() => rig.read()).toThrow(/copied nothing/); // no publish announced: nothing new
  });

  it('a read allocates nothing (a small measurement; the full one is the bench case)', () => {
    expect(bytesPerRead(snapshotReadRig(), 1_000, 2)).toBeLessThan(READ_ALLOCATION_GATE_BYTES);
  });

  it('the measure catches a read that allocates', () => {
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
    expect(bytesPerRead(leaky, 1_000, 2)).toBeGreaterThan(32 * READ_ALLOCATION_GATE_BYTES);
  });
});

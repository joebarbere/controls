import {
  bytesPerRead,
  READ_ALLOCATION_GATE_BYTES,
  READ_PLANT,
  READ_SMOKE_PLANT,
  snapshotReadRig,
} from './snapshot-read';

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
    expect(bytesPerRead(snapshotReadRig(), 1_000)).toBeLessThan(READ_ALLOCATION_GATE_BYTES);
  });

  it('with the netlist readout (F2.6): reads every node and branch, still allocating nothing', () => {
    const rig = snapshotReadRig(READ_PLANT, { netlist: true });
    rig.announce();
    rig.read();
    const plain = snapshotReadRig();
    plain.announce();
    plain.read();
    // Every node is at (1.5, 1.5) V like its reference node: 0 V. Every branch carries (0.25, 0.25) A,
    // |I| = 0.25 √2, from a to b (the rig's islands are DC).
    // Protocol 7: every connection record's temperature (300–304 K) and its status (solved, 1).
    let records = 0;
    for (let i = 0; i < READ_PLANT.connections; i++) records += 300 + (i % 5) + 1;
    expect(rig.sum()).toBeCloseTo(plain.sum() + READ_PLANT.branches * Math.hypot(0.25, 0.25) + records, 6);
    // Windows scaled to the read's cost: under Vitest's module runner a full-plant readout costs about
    // 0.6 ms (one core; 15× the bench's plain-Node 0.077 ms), so 1,000-read windows after a 20,000-read
    // warm-up took 25 s on one core and timed out on macOS CI (60.5 s). Each read runs about 4,500
    // record loops, so 2,500 reads warm it up; 250-read windows still read a planted 32 B object at
    // 41–45 B a read. Measured on one core: 4.5–5.4 s, 0 B in 10 of 10 fresh processes. The full-size
    // gate is the bench's `overlay-read-500-devices`, in plain Node.
    expect(bytesPerRead(snapshotReadRig(READ_PLANT, { netlist: true }), 250, 7, 2_500)).toBeLessThan(
      READ_ALLOCATION_GATE_BYTES,
    );
  });

  it("the smoke run's plant is a tenth of every count, and its reads allocate nothing either", () => {
    for (const key of Object.keys(READ_PLANT) as (keyof typeof READ_PLANT)[]) {
      expect(READ_SMOKE_PLANT[key] * 10).toBe(READ_PLANT[key]);
    }
    for (const netlist of [false, true]) {
      expect(bytesPerRead(snapshotReadRig(READ_SMOKE_PLANT, { netlist }), 1_000)).toBeLessThan(
        READ_ALLOCATION_GATE_BYTES,
      );
    }
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
    expect(bytesPerRead(leaky, 1_000)).toBeGreaterThan(32 * READ_ALLOCATION_GATE_BYTES);
  });

  it('a one-off burst in one window is not a per-read allocation (the median ignores it)', () => {
    // As when the read briefly runs unoptimised: bursts of up to 37 kB in about 1 window in 100, which
    // the old smallest-window slopes read as 1.024 and 3.024 B a read on CI (#144, #152).
    const rig = snapshotReadRig(READ_SMOKE_PLANT);
    const kept: number[][] = [];
    let reads = 0;
    const bursty = {
      announce: () => rig.announce(),
      read: () => {
        rig.read();
        if (++reads === 20_000 + 2_500) kept[0] = new Array(5_000).fill(0.5); // 40 kB, in the third window
      },
      sum: () => rig.sum(),
    };
    expect(bytesPerRead(bursty, 1_000)).toBeLessThan(READ_ALLOCATION_GATE_BYTES);
    expect(kept[0]).toHaveLength(5_000); // it ran, inside the measured windows
  });
});

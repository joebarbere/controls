import type { SourcedConstant } from '@controls/sim-core';

/*
 * The bench's calibration loop (plan F2.2 part 3b): a fixed workload that measures how fast this
 * machine is right now, so a budget written for the reference machine can be scaled to it. The
 * re-solve gate is
 *
 *   median(re-solve) ≤ 2 ms × median(calibration here) / CALIBRATION_REFERENCE_MS,
 *
 * with the two timed run for run in the same process (bench.ts), so a slower or a loaded runner
 * slows both, and `pnpm verify` gates the same ratio on every OS.
 *
 * **It shares no code with what it calibrates.** A regression in the solver, the compiler or a
 * library they use (`world-model`'s SHA-256, the catalogue) must never slow the calibration too, or
 * the gate would absorb it. So this file imports only a type, and calls nothing outside itself. It
 * does the same *kinds* of work as a re-solve, each a fixed amount on fixed inputs:
 *
 * 1. **gather:** a multiply-add over 128 KiB of doubles through a fixed pseudo-random permutation,
 *    like the sparse LU's scattered loads (L2-sized, as an island's factors are);
 * 2. **mix:** 32-bit rotates, xors and adds over a 64-word schedule, like the SHA-256 of the topology;
 * 3. **allocate:** 20,000 short-lived records in chains and arrays, then walked, as the compiler
 *    builds a netlist's nodes, branches and islands;
 * 4. **walk:** a pointer chase round a persistent ring of 4,096 records, like the compiler's pass over
 *    its cached entries.
 *
 * The parts take roughly the shares of a re-solve's time that their kinds do (about a fifth each
 * for the gather and the mix, the rest object work). Measured beside the re-solve on the reference
 * machine, the mix tracked it better under load than any part alone: a 1 MiB gather or a 32 Ki-record
 * walk slowed 3–6× under contention (memory-bound) where the re-solve slowed 2×, and the integer mix
 * alone hardly slowed at all. Keeping each run's records alive until the next (as the compiler keeps
 * its last netlist) was tried and dropped: they reached the old generation, and a major collection
 * landing in some processes' calibration runs but not others' spread its median 2.7× (1.3× without).
 * Each run returns a checksum, which the bench requires to be the same on every run.
 */

/**
 * The calibration's median on the reference machine: the denominator of the gate's scale. Re-measure
 * it whenever this file's workload changes (docs/caveats/simulation.md, "Re-baselining the
 * calibration"), never to make a failing gate pass.
 */
export const CALIBRATION_REFERENCE_MS: SourcedConstant = {
  value: 0.69,
  unit: 'ms',
  kind: 'numerical',
  source:
    'numerical: measured on the reference machine, an AMD Ryzen 5 5600X (6 cores, 12 threads, 3 MiB L2, 32 MiB L3) with 62 GiB, Fedora 44 (Linux 7.2), Node 24.12.0, on 2026-10-31: the median over 31 runs of `node dist/apps/sim-cli/main.mjs bench` of the calibration loop’s median (51 timed runs each, beside the re-solve case), 0.686 ms, rounded to 0.69 (range 0.567–1.460 ms). Other work kept the load average at 4–10 throughout, so the value leans slow, which makes the gate stricter, not looser. The re-solve measured 1.29 ms median in the same runs.',
};

/** Doubles in the gather (128 KiB). */
const GATHER_LENGTH = 1 << 14;
/** Gather passes per run. */
const GATHER_PASSES = 8;
/** Blocks of 64 integer rounds per run. */
const MIX_BLOCKS = 1200;
/** Records allocated per run. */
const RECORDS = 20000;
/** Records in the persistent ring. */
const RING_SIZE = 1 << 12;
/** Steps of the walk per run (eight laps). */
const WALK_STEPS = 1 << 15;

/** A record of the persistent ring, allocated in one order and linked in a shuffled one. */
interface RingRecord {
  readonly value: number;
  readonly label: string;
  next: RingRecord | null;
}

interface Inputs {
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly permutation: Int32Array;
  readonly words: Int32Array;
  readonly ring: RingRecord;
}

let inputs: Inputs | null = null;

/** The fixed inputs, built once (on the first warm-up run). A 32-bit LCG: deterministic, no clock. */
function calibrationInputs(): Inputs {
  if (inputs !== null) return inputs;
  let state = 0x2026_1031;
  const next = () => (state = (Math.imul(state, 1_664_525) + 1_013_904_223) | 0);
  /** 0 … n − 1, shuffled (Fisher–Yates). */
  const shuffled = (n: number): Int32Array => {
    const order = new Int32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    for (let i = n - 1; i > 0; i--) {
      const j = (next() >>> 1) % (i + 1);
      const t = order[i];
      order[i] = order[j];
      order[j] = t;
    }
    return order;
  };
  const x = new Float64Array(GATHER_LENGTH);
  for (let i = 0; i < GATHER_LENGTH; i++) x[i] = ((next() >>> 8) % 1000) / 64;
  const permutation = shuffled(GATHER_LENGTH);
  const words = new Int32Array(64);
  for (let i = 0; i < 64; i++) words[i] = next();
  const records: RingRecord[] = [];
  for (let i = 0; i < RING_SIZE; i++) records.push({ value: i % 251, label: `r${i % 97}`, next: null });
  const order = shuffled(RING_SIZE);
  for (let i = 0; i < RING_SIZE; i++) records[order[i]].next = records[order[(i + 1) % RING_SIZE]];
  inputs = { x, y: new Float64Array(GATHER_LENGTH), permutation, words, ring: records[0] };
  return inputs;
}

/** Part 1: the gathered multiply-add. `y` starts from the same values every run. */
export function calibrationGather(): number {
  const { x, y, permutation } = calibrationInputs();
  y.fill(1);
  let sum = 0;
  for (let pass = 0; pass < GATHER_PASSES; pass++) {
    for (let i = 0; i < GATHER_LENGTH; i++) {
      const v = y[i] * 0.5 + x[permutation[i]] * 1.25;
      y[i] = v;
      sum += v;
    }
  }
  return sum;
}

/** Part 2: integer mixing, SHA-like rounds over a fixed schedule. */
export function calibrationMix(): number {
  const { words } = calibrationInputs();
  let a = 0x6a09e667 | 0;
  let b = 0xbb67ae85 | 0;
  let c = 0x3c6ef372 | 0;
  let d = 0xa54ff53a | 0;
  for (let block = 0; block < MIX_BLOCKS; block++) {
    for (let t = 0; t < 64; t++) {
      const s = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((b >>> 22) | (b << 10));
      const ch = (b & c) ^ (~b & d);
      const t1 = (d + s + ch + words[t] + block) | 0;
      d = c;
      c = b;
      b = a;
      a = t1;
    }
  }
  return (a ^ b ^ c ^ d) >>> 0;
}

interface ChainRecord {
  readonly value: number;
  readonly parent: ChainRecord | null;
}

/** Part 3: allocation: records in chains (reset every 8), gathered into arrays of 4, then walked. */
export function calibrationAllocate(): number {
  const groups: ChainRecord[][] = [];
  let parent: ChainRecord | null = null;
  for (let i = 0; i < RECORDS; i++) {
    const record: ChainRecord = { value: (i * 7) % 13, parent: i % 8 === 0 ? null : parent };
    parent = record;
    if (i % 4 === 0) groups.push([]);
    groups[groups.length - 1].push(record);
  }
  let walked = 0;
  for (const group of groups) {
    for (const record of group) {
      for (let r: ChainRecord | null = record; r !== null; r = r.parent) walked += r.value;
    }
  }
  return walked;
}

/** Part 4: a pointer chase round the persistent ring. */
export function calibrationWalk(): number {
  let record = calibrationInputs().ring;
  let sum = 0;
  for (let i = 0; i < WALK_STEPS; i++) {
    sum += record.value + record.label.length;
    record = record.next as RingRecord;
  }
  return sum;
}

/** One run of the calibration workload. Returns its checksum (the same on every run). */
export function runCalibration(): string {
  return `${calibrationGather()}:${calibrationMix()}:${calibrationAllocate()}:${calibrationWalk()}`;
}

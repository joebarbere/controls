import fc from 'fast-check';
import { assertNoNegativeZero, rawReplayLogV2Arb } from '../../testing/arbitraries';
import { createReplayLog, createWorld, migrateReplayLog } from '../documents';
import { ReplayLogV2 } from './replay-log';

const entry = (seq: number, tick = 0, id = 'entity.place', args: Record<string, never> = {}) => ({
  seq,
  tick,
  id,
  args,
});

const log = (entries: unknown[], options: { initialTick?: number; firstSeq?: number; endTick?: number } = {}) => ({
  schemaVersion: 2,
  initialWorld: { ...createWorld({ seed: 1 }), tick: options.initialTick ?? 0 },
  firstSeq: options.firstSeq ?? 0,
  entries,
  endTick: options.endTick ?? (entries.at(-1) as { tick?: number } | undefined)?.tick ?? options.initialTick ?? 0,
});

const messages = (input: unknown) => {
  const result = ReplayLogV2.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};

describe('ReplayLogV2', () => {
  it('createReplayLog starts an empty log at seq 0 that ends at the initial tick', () => {
    const initialWorld = { ...createWorld({ seed: 9 }), tick: 40 };
    expect(createReplayLog(initialWorld)).toStrictEqual({
      schemaVersion: 2,
      initialWorld,
      firstSeq: 0,
      entries: [],
      endTick: 40,
    });
    const entries = [entry(5, 41, 'view.resetLayout')];
    expect(createReplayLog(initialWorld, entries, { firstSeq: 5 })).toMatchObject({ firstSeq: 5, endTick: 41 });
    expect(createReplayLog(initialWorld, entries, { firstSeq: 5, endTick: 90 }).endTick).toBe(90);
    expect(() => createReplayLog(initialWorld, entries)).toThrow(); // seq 5 is not firstSeq 0
  });

  it('entries count up from firstSeq without gaps', () => {
    expect(messages(log([entry(0), entry(1)]))).toStrictEqual([]);
    expect(messages(log([entry(7), entry(8)], { firstSeq: 7 }))).toStrictEqual([]);
    expect(messages(log([entry(1)]))).toContain('seq must be firstSeq + 0');
    expect(messages(log([entry(7), entry(9)], { firstSeq: 7 }))).toContain('seq must be firstSeq + 1');
    expect(messages(log([], { firstSeq: Number.MAX_SAFE_INTEGER }))).toStrictEqual([]);
    expect(messages(log([entry(Number.MAX_SAFE_INTEGER)], { firstSeq: Number.MAX_SAFE_INTEGER }))).toContain(
      'firstSeq + entries must stay a safe integer',
    );
    expect(messages(log([], { firstSeq: -1 }))).not.toHaveLength(0);
  });

  it('endTick ≥ last entry tick ≥ initialWorld.tick; a lower endTick is refused', () => {
    expect(messages(log([entry(0, 5), entry(1, 9)], { initialTick: 5, endTick: 9 }))).toStrictEqual([]);
    expect(messages(log([entry(0, 5)], { initialTick: 5, endTick: 2 ** 40 }))).toStrictEqual([]);
    expect(messages(log([entry(0, 5), entry(1, 9)], { initialTick: 5, endTick: 8 }))).toContain(
      'endTick must not be before the last entry (or the initial world)',
    );
    expect(messages(log([], { initialTick: 5, endTick: 4 }))).toContain(
      'endTick must not be before the last entry (or the initial world)',
    );
    expect(messages(log([entry(0, 4)], { initialTick: 5, endTick: 5 }))).toContain(
      'tick must not go backwards (or start before the initial world)',
    );
  });

  it('refuses malformed entries and unknown keys', () => {
    expect(messages(log([entry(0, 0, 'Entity Place')]))).not.toHaveLength(0);
    expect(messages(log([{ ...entry(0), args: [1] }]))).not.toHaveLength(0);
    expect(messages({ ...log([]), lastSeq: 0 })).not.toHaveLength(0);
    const missing: Record<string, unknown> = log([]);
    delete missing['endTick'];
    expect(messages(missing)).not.toHaveLength(0);
  });

  it('round-trips any valid log losslessly through JSON (property)', () => {
    fc.assert(
      fc.property(rawReplayLogV2Arb, (raw) => {
        const parsed = ReplayLogV2.parse(raw);
        assertNoNegativeZero(parsed);
        const text = JSON.stringify(parsed);
        expect(ReplayLogV2.parse(JSON.parse(text))).toStrictEqual(parsed);
        expect(migrateReplayLog(JSON.parse(text))).toStrictEqual({ ok: true, value: parsed, fromVersion: 2 });
      }),
      { numRuns: 50 },
    );
  });
});

import fc from 'fast-check';
import { assertNoNegativeZero, rawReplayLogV3Arb } from '../../testing/arbitraries';
import { migrateReplayLog } from '../documents';
import { replayLogV3ToV4 } from '../v4/from-v3';
import { ReplayLogV3 } from './replay-log';

const entry = (seq: number, tick = 0, id = 'entity.place', args: Record<string, never> = {}) => ({
  seq,
  tick,
  id,
  args,
});

/** `createWorld({ seed: 1 })` as it was at schemaVersion 3. */
const v3World = {
  schemaVersion: 3,
  seed: 1,
  tick: 0,
  nextEntityId: 1,
  nextConnectionId: 1,
  nextCableId: 1,
  nextTerminationId: 1,
  regionId: 'nec',
  difficulty: 'apprentice',
  assisted: false,
  fixtures: [],
  entities: [],
  connections: [],
  cables: [],
  sim: null,
  extensions: {},
};

const log = (entries: unknown[], options: { initialTick?: number; firstSeq?: number; endTick?: number } = {}) => ({
  schemaVersion: 3,
  initialWorld: { ...v3World, tick: options.initialTick ?? 0 },
  firstSeq: options.firstSeq ?? 0,
  entries,
  endTick: options.endTick ?? (entries.at(-1) as { tick?: number } | undefined)?.tick ?? options.initialTick ?? 0,
});

const messages = (input: unknown) => {
  const result = ReplayLogV3.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};

describe('ReplayLogV3', () => {
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
      fc.property(rawReplayLogV3Arb, (raw) => {
        const parsed = ReplayLogV3.parse(raw);
        assertNoNegativeZero(parsed);
        const text = JSON.stringify(parsed);
        expect(ReplayLogV3.parse(JSON.parse(text))).toStrictEqual(parsed);
        expect(migrateReplayLog(JSON.parse(text))).toStrictEqual({
          ok: true,
          value: replayLogV3ToV4(parsed),
          fromVersion: 3,
        });
      }),
      { numRuns: 50 },
    );
  });
});

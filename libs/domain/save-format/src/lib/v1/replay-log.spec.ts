import fc from 'fast-check';
import { assertNoNegativeZero, rawReplayLogV1Arb } from '../../testing/arbitraries';
import { migrateReplayLog } from '../documents';
import { replayLogV1ToV2 } from '../v2/from-v1';
import { ReplayLogV1 } from './replay-log';

const entry = (seq: number, tick = 0, id = 'entity.place', args: Record<string, unknown> = {}) => ({
  seq,
  tick,
  id,
  args,
});

const log = (entries: unknown[], initialTick = 0) => ({
  schemaVersion: 1,
  initialWorld: {
    schemaVersion: 1,
    seed: 1,
    tick: initialTick,
    nextEntityId: 1,
    regionId: 'nec',
    difficulty: 'apprentice',
    assisted: false,
    fixtures: [],
    entities: [],
    extensions: {},
  },
  entries,
});

const messages = (input: unknown) => {
  const result = ReplayLogV1.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};

describe('ReplayLogV1', () => {
  it('accepts { seq, tick, id, args } entries with JSON args', () => {
    const args = { ref: { id: 'prop.crate', version: 1 }, positionMm: { x: 10, y: 0, z: -20 }, note: null };
    expect(messages(log([entry(0, 0, 'entity.place', args), entry(1, 0, 'edit.undo')]))).toHaveLength(0);
  });

  it('requires seq to count up from 0 without gaps', () => {
    expect(messages(log([entry(1)]))).toContain('seq must be 0');
    expect(messages(log([entry(0), entry(2)]))).toContain('seq must be 1');
  });

  it('requires ticks never to go backwards, starting from the initial world’s tick', () => {
    expect(messages(log([entry(0, 5), entry(1, 5), entry(2, 6)], 5))).toHaveLength(0);
    expect(messages(log([entry(0, 5), entry(1, 4)]))).toContain(
      'tick must not go backwards (or start before the initial world)',
    );
    expect(messages(log([entry(0, 4)], 5))).toContain('tick must not go backwards (or start before the initial world)');
  });

  it('rejects malformed command ids and non-object args', () => {
    expect(messages(log([entry(0, 0, 'Entity Place')]))).not.toHaveLength(0);
    expect(messages(log([{ ...entry(0), args: [1, 2] }]))).not.toHaveLength(0);
    expect(messages(log([{ ...entry(0), args: { x: Number.NaN } }]))).not.toHaveLength(0);
    expect(messages(log([{ ...entry(0), extra: 1 }]))).not.toHaveLength(0);
  });

  it('round-trips any valid log losslessly through JSON (property)', () => {
    fc.assert(
      fc.property(rawReplayLogV1Arb, (raw) => {
        const parsed = ReplayLogV1.parse(raw);
        assertNoNegativeZero(parsed);
        const text = JSON.stringify(parsed);
        expect(ReplayLogV1.parse(JSON.parse(text))).toStrictEqual(parsed);
        expect(migrateReplayLog(JSON.parse(text))).toStrictEqual({
          ok: true,
          value: replayLogV1ToV2(parsed),
          fromVersion: 1,
        });
      }),
      { numRuns: 50 },
    );
  });
});

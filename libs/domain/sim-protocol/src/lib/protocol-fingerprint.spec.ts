import { DeviceStateBag, ReplayEntry, ReplayLog, SimSolutionV2, World } from '@controls/save-format';
import { z } from 'zod';
import * as buffer from './buffer';
import { TopologyDescriptorSchema } from './descriptor';
import { DEVICE_OUTPUT_SCHEMAS, NOMINAL_BANDS, RECORD_STATUS_VALUES } from './device-output';
import { SIM_EVENT_KINDS } from './events';
import * as layout from './layout';
import { HostToWorker, SimErrorCode, SimStartReason, WorkerToHost } from './messages';
import { snapshotHash } from './snapshot';

/*
 * `SIM_PROTOCOL_VERSION` guards the whole contract (ADR 0011 §12), but a layout change made
 * consistently on both sides (a model and the registry, the encoder and the reader) passes every
 * agreement test without a bump (F2.5 test review). So the contract's data is fingerprinted here and
 * the fingerprint is pinned **per version**: any change to the snapshot layout, the island encoding,
 * `NOMINAL_BANDS`, a device output schema, the event kinds, the message types and fields or the
 * descriptor's shape fails until the fingerprint is re-pinned, and it can only be re-pinned next to
 * a new version number.
 *
 * To change the contract: bump `SIM_PROTOCOL_VERSION`, add its fingerprint below (keep the old
 * ones: history), amend ADR 0011 and re-pin the snapshot goldens. **A pin is never edited**: a
 * version's fingerprint is what that version shipped; a different contract is a new version. The
 * newest pin must be the current version, so a pin can't be added ahead of the bump either.
 *
 * **The one exception, a change of the fingerprint's own definition** (#75 review, 2026-10-31):
 * the fingerprint first covered the message type names only; it now covers each message's fields
 * too. Protocol 5 itself did not change, so its pin was replaced once (from `a0d9c021…a092`, the
 * names-only fingerprint) rather than bumping the version. Widening the coverage again is the same
 * kind of change; changing the contract never is.
 */

const PINNED: Readonly<Record<number, string>> = {
  5: '82368a1db218fb1bbd70b2d9bf3dd0a6d021215060f2b8205574c18d8e9d5e6b',
};

/** The contract's data, as canonical JSON (sorted keys). Functions and Zod internals are left out. */
function protocolContract(): unknown {
  const constants = (module: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(module)
        .filter(([name, value]) => name !== 'SIM_PROTOCOL_VERSION' && typeof value !== 'function')
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  const messageTypes = (union: { options: readonly { shape: { type: { value: string } } }[] }) =>
    union.options.map((o) => o.shape.type.value).sort();
  // Every message's fields, not only its type name (#75 review). The save-format schemas a message
  // carries (a world, a log, a sim bag, a solution record) are save format, versioned by
  // `schemaVersion` (§12 "Not covered"), so they enter by name only; a buffer or typed array (a
  // `z.custom`) has no JSON Schema and enters as `{}`.
  const saveFormat = new Map<unknown, string>([
    [World, 'World'],
    [ReplayEntry, 'ReplayEntry'],
    [ReplayLog, 'ReplayLog'],
    [DeviceStateBag, 'DeviceStateBag'],
    [SimSolutionV2, 'SimSolutionV2'],
  ]);
  const messageSchemas = (union: z.ZodType) =>
    z.toJSONSchema(union, {
      unrepresentable: 'any',
      override: (ctx) => {
        const name = saveFormat.get(ctx.zodSchema);
        if (name === undefined) return;
        for (const key of Object.keys(ctx.jsonSchema)) delete (ctx.jsonSchema as Record<string, unknown>)[key];
        (ctx.jsonSchema as Record<string, unknown>)['x-save-format'] = name;
      },
    });
  return {
    layout: constants(layout as unknown as Record<string, unknown>),
    buffer: constants(buffer as unknown as Record<string, unknown>),
    nominalBands: NOMINAL_BANDS,
    deviceOutputs: DEVICE_OUTPUT_SCHEMAS,
    recordStatus: RECORD_STATUS_VALUES,
    events: SIM_EVENT_KINDS,
    hostToWorker: messageTypes(HostToWorker as never),
    workerToHost: messageTypes(WorkerToHost as never),
    hostToWorkerSchema: messageSchemas(HostToWorker),
    workerToHostSchema: messageSchemas(WorkerToHost),
    errorCodes: SimErrorCode.options,
    startReasons: SimStartReason.options,
    descriptor: z.toJSONSchema(TopologyDescriptorSchema),
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const fingerprint = () => snapshotHash(new TextEncoder().encode(canonical(protocolContract())));

describe('the protocol fingerprint (ADR 0011 §12)', () => {
  it('is pinned for this SIM_PROTOCOL_VERSION: a contract change needs a version bump beside it', () => {
    expect(
      PINNED[layout.SIM_PROTOCOL_VERSION],
      `no fingerprint pinned for protocol ${layout.SIM_PROTOCOL_VERSION}`,
    ).toBe(fingerprint());
    // The newest pin is this version: no fingerprint pinned for a version that doesn't exist yet.
    expect(Math.max(...Object.keys(PINNED).map(Number))).toBe(layout.SIM_PROTOCOL_VERSION);
  });

  it('covers the island encoding, the bands, the device records and the messages', () => {
    const contract = protocolContract() as Record<string, Record<string, unknown>>;
    expect(contract['layout']).toHaveProperty('ISLAND_OFFSETS');
    expect(contract['layout']).toHaveProperty('SLOT_OFFSETS');
    expect(contract['buffer']).toHaveProperty('DIAG_OFFSETS');
    expect(Object.keys(contract['deviceOutputs']).length).toBeGreaterThan(0);
    expect(contract['hostToWorker']).toContain('query');
    expect(contract['workerToHost']).toContain('snapshotBytes');
    // Each part bites: a band appended, or a record field renamed, moves it.
    const base = fingerprint();
    const moved = (patch: (c: Record<string, unknown>) => void) => {
      const c = JSON.parse(JSON.stringify(protocolContract())) as Record<string, unknown>;
      patch(c);
      return snapshotHash(new TextEncoder().encode(canonical(c)));
    };
    expect(moved((c) => (c['nominalBands'] as string[]).push('dc48'))).not.toBe(base);
    expect(moved((c) => ((c['layout'] as Record<string, unknown>)['ISLAND_ENTRY_BYTES'] = 24))).not.toBe(base);
    const [kind] = Object.keys(DEVICE_OUTPUT_SCHEMAS);
    expect(
      moved((c) => ((c['deviceOutputs'] as Record<string, Record<string, unknown>>)[kind]['recordBytes'] = 0)),
    ).not.toBe(base);
  });

  it("covers each message's fields, with the save-format schemas it carries by name only (#75 review)", () => {
    const contract = protocolContract() as Record<string, unknown>;
    const host = JSON.stringify(contract['hostToWorkerSchema']);
    const worker = JSON.stringify(contract['workerToHostSchema']);
    // The protocol's own fields are in it: init's start, a watch's target, a trace's samples, an error's reason.
    for (const field of ['"firstSeq"', '"transport"', '"element"', '"connection"']) expect(host).toContain(field);
    for (const field of ['"samples"', '"snapshotHash"', '"reason"', '"isolated"']) expect(worker).toContain(field);
    // Save format enters by name: a world field is not in the fingerprint (schemaVersion versions it).
    expect(host).toContain('"x-save-format":"World"');
    expect(host).toContain('"x-save-format":"ReplayLog"');
    expect(worker).toContain('"x-save-format":"SimSolutionV2"');
    expect(host).not.toContain('nextConnectionId');
    // A field added to a message moves it.
    const base = fingerprint();
    const c = JSON.parse(JSON.stringify(contract)) as Record<string, Record<string, { properties: object }[]>>;
    const options = c['hostToWorkerSchema']['oneOf'] ?? c['hostToWorkerSchema']['anyOf'] ?? [];
    const watch = options.find((o) => JSON.stringify(o).includes('"const":"watch"'));
    expect(watch).toBeDefined();
    (watch as { properties: Record<string, unknown> }).properties['rateHz'] = { type: 'number' };
    expect(snapshotHash(new TextEncoder().encode(canonical(c)))).not.toBe(base);
  });
});

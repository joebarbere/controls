import { DeviceStateBag, ReplayEntry, ReplayLog, SimSolutionV2, World } from '@controls/save-format';
import * as z from 'zod';
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
 *
 * **The second definition change (world v3, P3 PR 7, 2026-11-11):** the save-format schemas were
 * meant to enter by name only, but `z.toJSONSchema` still emitted their registered sub-schemas
 * (`EntityV2`, `ConnectionV2`, …) as `$defs` of the message schemas, so world v3 moved the fingerprint
 * without any change to the protocol. Save-format `$ref`s are now inlined by name and `$defs` that no
 * protocol field reaches are pruned, so a `schemaVersion` bump can never move it again (checked when
 * the change was made: the messages built on the v2 and the v3 schemas give the same fingerprint).
 * Protocol 5's pin was replaced once (from `82368a1d…5e6b`) rather than bumping the version, as #75's was.
 */

const PINNED: Readonly<Record<number, string>> = {
  5: '94d71fbbe3b973e30eee08c40bdd40b2ad2a4bfc9af0a50d6a831ec40eda43a6',
  // 6 (F3.6 part 1): `SimStateExport.connections`, every connection's sim bag in the `state` reply.
  6: 'c0820b25bb7eb44de14ded06a6637d66b2bf4e97e107e8108832638e1fe36891',
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
    reachableDefsOnly(
      z.toJSONSchema(union, {
        unrepresentable: 'any',
        override: (ctx) => {
          const name = saveFormat.get(ctx.zodSchema);
          if (name === undefined) return;
          for (const key of Object.keys(ctx.jsonSchema)) delete (ctx.jsonSchema as Record<string, unknown>)[key];
          (ctx.jsonSchema as Record<string, unknown>)['x-save-format'] = name;
        },
      }) as Record<string, unknown>,
    );
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

/**
 * `schema` with save format by name only: a `$ref` to a save-format schema (a `$defs` entry that is
 * just `{ "x-save-format": name }`) is replaced by that entry, so the def's versioned name
 * (`ReplayEntryV3`) never enters, and only the `$defs` some protocol field still reaches are kept. A
 * save-format schema replaced by its name otherwise leaves its registered sub-schemas behind as
 * unreferenced `$defs`; they are save format, versioned by `schemaVersion`, not protocol.
 */
function reachableDefsOnly(schema: Record<string, unknown>): Record<string, unknown> {
  const defs = (schema['$defs'] ?? {}) as Record<string, Record<string, unknown>>;
  const root = Object.fromEntries(Object.entries(schema).filter(([key]) => key !== '$defs'));
  const isSaveFormat = (def: Record<string, unknown> | undefined) =>
    def !== undefined && Object.keys(def).length === 1 && typeof def['x-save-format'] === 'string';
  const reached = new Set<string>();
  const pending: string[] = [];
  const rewrite = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(rewrite);
    if (node === null || typeof node !== 'object') return node;
    const ref = (node as Record<string, unknown>)['$ref'];
    if (typeof ref === 'string' && ref.startsWith('#/$defs/')) {
      const name = ref.slice('#/$defs/'.length);
      if (isSaveFormat(defs[name])) return { ...defs[name], ...withoutRef(node as Record<string, unknown>) };
      if (!reached.has(name) && Object.prototype.hasOwnProperty.call(defs, name)) {
        reached.add(name);
        pending.push(name);
      }
    }
    return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, rewrite(child)]));
  };
  const out = rewrite(root) as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  while (pending.length > 0) {
    const name = pending.pop() as string;
    kept[name] = rewrite(defs[name]);
  }
  return Object.keys(kept).length === 0 ? out : { ...out, $defs: kept };
}

/** A schema node's own keywords besides `$ref` (a `title` or `description` next to it). */
function withoutRef(node: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(node).filter(([key]) => key !== '$ref'));
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
    // …and none of its sub-schemas leaks in through `$defs` (world v3 review): only what a protocol field reaches.
    for (const leaked of ['EntityV', 'ConnectionV', 'FixtureV', 'ReplayEntryV', 'TerminationV']) {
      expect(host + worker, leaked).not.toContain(leaked);
    }
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

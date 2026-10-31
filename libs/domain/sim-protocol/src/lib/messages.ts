import { ReplayEntry, ReplayLog, World } from '@controls/save-format';
import { z } from 'zod';
import { isSharedArrayBuffer } from './buffer';
import { type TopologyDescriptor, TopologyDescriptorSchema } from './descriptor';
import { SIM_EVENT_KINDS, type SimEvent } from './events';
import { SimStateExport } from './materialise';

/*
 * The worker message protocol (ADR 0011 §4), as Zod schemas parsed on receipt at both ends. `World`,
 * `ReplayEntry` and `ReplayLog` are the save-format schemas. Everything here is covered by
 * `SIM_PROTOCOL_VERSION`: changing a message, even additively, bumps it (§12).
 *
 * Errors never echo a payload: a message that doesn't parse is `invalid-message` with a fixed text.
 */

const Tick = z.int().min(0);
const QueryId = z.int().min(0);

const SharedBuffer = z.custom<SharedArrayBuffer>((value) => isSharedArrayBuffer(value), 'a SharedArrayBuffer');
const PlainBuffer = z.custom<ArrayBuffer>(
  (value) => Object.prototype.toString.call(value) === '[object ArrayBuffer]',
  'an ArrayBuffer',
);

export const SimTransport = z.enum(['sab', 'message']);
export type SimTransport = z.infer<typeof SimTransport>;

/**
 * How a worker starts (ADR 0011 §4): from a materialised world at a `seq` (a new game, a world after
 * a restarted load), or by replaying a log (load verification, the crash restart).
 */
export const SimStart = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('world'), world: World, firstSeq: z.int().min(0) }),
  z.strictObject({ kind: z.literal('replay'), log: ReplayLog }),
]);
export type SimStart = z.infer<typeof SimStart>;

/** View state for traces (F2.6): never logged, never affects the engine. */
export const WatchTarget = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('branch'),
    element: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('entity'), entity: z.int().min(1), part: z.string().min(1).max(32) }),
      z.strictObject({ kind: z.literal('connection'), connection: z.int().min(1) }),
    ]),
  }),
  z.strictObject({ kind: z.literal('device'), entity: z.int().min(1), field: z.string().min(1).max(64) }),
]);
export type WatchTarget = z.infer<typeof WatchTarget>;

/** Main → worker. */
export const HostToWorker = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('init'), protocol: z.int(), transport: SimTransport, start: SimStart }),
  /** The new target: strictly increasing. */
  z.strictObject({ type: z.literal('advance'), tick: Tick }),
  /** Every logged entry, contiguous `seq`, stamped with main's tick. */
  z.strictObject({ type: z.literal('command'), entry: ReplayEntry }),
  z.strictObject({ type: z.literal('query'), id: QueryId, query: z.enum(['state', 'snapshot']), tick: Tick }),
  z.strictObject({ type: z.literal('watch'), id: QueryId, target: WatchTarget }),
  z.strictObject({ type: z.literal('unwatch'), id: QueryId }),
  /** Fallback only: hands a pooled buffer back (transferred). */
  z.strictObject({ type: z.literal('release'), buffer: PlainBuffer }),
  z.strictObject({ type: z.literal('stop') }),
]);
export type HostToWorker = z.infer<typeof HostToWorker>;

export const SimErrorCode = z.enum([
  'protocol-mismatch',
  /** Includes a big-endian platform and a solution record that doesn't fit its netlist (§9.6). */
  'start-failed',
  /** The text never echoes the payload. */
  'invalid-message',
  'desync',
  /** Also `self.onerror`, `unhandledrejection` and a non-finite value reaching the export. */
  'engine-threw',
  /** A `securitypolicyviolation` seen in the worker's own scope. */
  'csp-violation',
  /** A slot can't be allocated; never a partial publish. */
  'capacity',
]);
export type SimErrorCode = z.infer<typeof SimErrorCode>;

/**
 * Why a world can't start the engine (`SimStartError.reason` in sim-core, ADR 0011 §9.6), sent with a
 * `start-failed` error so the host refuses a damaged save only for a real reason (protocol 2).
 */
export const SimStartReason = z.enum(['solution-on-empty-netlist', 'topology-mismatch', 'length-mismatch']);
export type SimStartReason = z.infer<typeof SimStartReason>;

/** Host-side rejections of a pending query (never on the wire). */
export type SimQueryError = 'superseded' | 'timeout' | 'crashed' | 'unavailable';

const SimEventSchema = z.strictObject({
  tick: Tick,
  kind: z.enum(SIM_EVENT_KINDS),
  entity: z.int().min(1).nullable(),
  entities: z.array(z.int().min(1)),
  detail: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
});

/** Worker → main. */
export const WorkerToHost = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('ready'),
    protocol: z.int(),
    transport: SimTransport,
    /** `self.crossOriginIsolated`, from the worker's own scope. */
    isolated: z.boolean(),
    buffer: SharedBuffer.nullable(),
    tick: Tick,
  }),
  /** `buffer`: a replacement shared buffer when capacity grew. */
  z.strictObject({
    type: z.literal('topology'),
    descriptor: TopologyDescriptorSchema,
    buffer: SharedBuffer.nullable(),
  }),
  /** Fallback only: one slot, transferred. */
  z.strictObject({ type: z.literal('snapshot'), buffer: PlainBuffer }),
  z.strictObject({ type: z.literal('events'), events: z.array(SimEventSchema) }),
  /** (tick, value) pairs at every solve since the last batch (F2.6). */
  z.strictObject({
    type: z.literal('trace'),
    id: QueryId,
    samples: z.custom<Float64Array>((v) => v instanceof Float64Array),
  }),
  z.strictObject({
    type: z.literal('state'),
    id: QueryId,
    tick: Tick,
    export: SimStateExport,
    snapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  /** The reply to query `snapshot`: the hashed bytes encoded at exactly that tick. */
  z.strictObject({ type: z.literal('snapshotBytes'), id: QueryId, tick: Tick, bytes: PlainBuffer }),
  z.strictObject({
    type: z.literal('error'),
    code: SimErrorCode,
    message: z.string().max(500),
    seq: z.int().min(0).nullable(),
    tick: Tick.nullable(),
    /** `start-failed` from a solution record that doesn't fit: why; `null` for every other error. */
    reason: SimStartReason.nullable(),
  }),
]);
export type WorkerToHost = z.infer<typeof WorkerToHost>;

/**
 * What a worker sends: {@link WorkerToHost}, with the descriptor and events in their read-only
 * domain types (the engine hands out frozen data; the receiving side parses into fresh objects).
 */
export type WorkerToHostMessage =
  | Exclude<WorkerToHost, { readonly type: 'topology' | 'events' }>
  | { readonly type: 'topology'; readonly descriptor: TopologyDescriptor; readonly buffer: SharedArrayBuffer | null }
  | { readonly type: 'events'; readonly events: readonly SimEvent[] };

/** Parses a received message; `null` (never the payload) if it isn't one. */
export function parseHostMessage(data: unknown): HostToWorker | null {
  const parsed = HostToWorker.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/** Parses a received message; `null` (never the payload) if it isn't one. */
export function parseWorkerMessage(data: unknown): WorkerToHost | null {
  const parsed = WorkerToHost.safeParse(data);
  return parsed.success ? parsed.data : null;
}

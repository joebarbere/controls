import type { ReplayEntry, World } from '@controls/save-format';
import type { SimEngineOptions } from '@controls/sim-core';
import {
  materialiseWorld,
  parseWorkerMessage,
  SIM_PROTOCOL_VERSION,
  SnapshotReader,
  type SimStart,
  type SnapshotView,
  type SimTransport,
  type WorkerToHost,
} from '@controls/sim-protocol';
import { worldHash } from '@controls/world-model';
import { SimWorkerRunner } from '../lib/runner';

/*
 * A deterministic host for runner specs: a manual task queue for the loop's yields, a fake clock,
 * and the host side of the protocol (a reader fed by `ready`, `topology` and `snapshot` messages,
 * releasing fallback buffers back). Every posted message is parsed with `WorkerToHost`, so the
 * specs also prove the runner only sends what the protocol allows.
 */
export class RunnerHarness {
  readonly messages: WorkerToHost[] = [];
  readonly tasks: (() => void)[] = [];
  readonly reader = new SnapshotReader();
  time = 0;
  /** Added to the clock on every read (simulates work taking wall time). */
  msPerRead = 0;
  transport: SimTransport | null = null;
  readonly runner: SimWorkerRunner;
  /** Fallback buffers the host holds instead of releasing (to starve the pool). */
  holdReleases = false;
  readonly held: ArrayBuffer[] = [];

  constructor(
    options: {
      readonly isolated?: boolean;
      readonly engine?: SimEngineOptions;
      readonly littleEndian?: boolean;
      readonly maxSlotBytes?: number;
      readonly minSlotBytes?: number;
      readonly sharedArrayBuffer?: boolean;
    } = {},
  ) {
    this.runner = new SimWorkerRunner(
      {
        post: (message, transfer = []) => {
          const copy = structuredClone(message, { transfer: [...transfer] });
          const parsed = parseWorkerMessage(copy);
          if (parsed === null) throw new Error(`the runner sent an invalid ${message.type} message`);
          this.messages.push(parsed);
          this.host(parsed);
        },
      },
      {
        isolated: options.isolated ?? true,
        sharedArrayBuffer: options.sharedArrayBuffer ?? true,
        littleEndian: options.littleEndian ?? true,
        clock: {
          now: () => {
            const t = this.time;
            this.time += this.msPerRead;
            return t;
          },
        },
        schedule: (task) => this.tasks.push(task),
        engine: options.engine,
        maxSlotBytes: options.maxSlotBytes,
        minSlotBytes: options.minSlotBytes,
      },
    );
  }

  /** Sends a message as the host would (a structured clone). */
  send(message: unknown): void {
    this.runner.receive(structuredClone(message));
  }

  init(start: SimStart, transport: SimTransport = 'sab'): void {
    this.send({ type: 'init', protocol: SIM_PROTOCOL_VERSION, transport, start });
  }

  /** Runs queued loop slices until the worker is idle; returns how many slices ran. */
  drain(limit = 100_000): number {
    let slices = 0;
    while (this.tasks.length > 0) {
      if (++slices > limit) throw new Error('the worker never went idle');
      (this.tasks.shift() as () => void)();
    }
    return slices;
  }

  /** The latest snapshot the host has seen. */
  view(): SnapshotView | null {
    return this.transport === 'sab' ? this.reader.latest() : this.reader.current;
  }

  of<T extends WorkerToHost['type']>(type: T): Extract<WorkerToHost, { type: T }>[] {
    return this.messages.filter((m): m is Extract<WorkerToHost, { type: T }> => m.type === type);
  }

  /** Sends a query and drains; returns the reply. */
  query(query: 'state' | 'snapshot', tick: number, id = this.messages.length + 1): WorkerToHost {
    this.send({ type: 'query', id, query, tick });
    this.drain();
    const reply = this.messages.find((m) => (m.type === 'state' || m.type === 'snapshotBytes') && m.id === id);
    if (reply === undefined) throw new Error(`no reply to query ${id}`);
    return reply;
  }

  /** `world.hash` of `busWorld` materialised with a `state` reply's export (what a save hashes). */
  static hashOf(busWorld: World, reply: WorkerToHost): string {
    if (reply.type !== 'state') throw new Error('not a state reply');
    return worldHash(materialiseWorld({ ...busWorld, tick: reply.tick }, reply.export));
  }

  private host(message: WorkerToHost): void {
    switch (message.type) {
      case 'ready':
        this.transport = message.transport;
        if (message.buffer !== null) this.reader.attach(message.buffer);
        return;
      case 'topology':
        this.reader.setDescriptor(message.descriptor);
        if (message.buffer !== null) this.reader.attach(message.buffer);
        return;
      case 'snapshot': {
        this.reader.acceptSlot(new Uint8Array(message.buffer));
        if (this.holdReleases) this.held.push(message.buffer);
        else this.send({ type: 'release', buffer: message.buffer });
        return;
      }
      default:
        return;
    }
  }
}

/** The entries of `entries` after the first `from`: what a host forwards after a command. */
export function newEntries(entries: readonly ReplayEntry[], from: number): readonly ReplayEntry[] {
  return entries.slice(from);
}

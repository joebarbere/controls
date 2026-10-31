import type { SimEngineOptions } from '@controls/sim-core';
import type { SimWorkerHandlers, SimWorkerLike } from '@controls/sim-protocol';
import { performanceClock, type WorkerClock } from './pacing/worker-clock';
import { platformIsLittleEndian, SimWorkerRunner } from './runner';

/** Options for {@link createInProcessSimWorker}. */
export interface InProcessSimWorkerOptions {
  /** What the worker reports as `self.crossOriginIsolated` (default `true`: the shared-buffer path). */
  readonly isolated?: boolean;
  readonly engine?: SimEngineOptions;
  readonly clock?: WorkerClock;
  /** Runs a task later (default `setTimeout(task, 0)`): message delivery in both directions and the loop's yields. */
  readonly defer?: (task: () => void) => void;
  readonly maxSlotBytes?: number;
}

/** An in-process sim worker, plus its runner for inspection. */
export interface InProcessSimWorker extends SimWorkerLike {
  readonly runner: SimWorkerRunner;
  /** Whether {@link SimWorkerLike.terminate} was called. */
  readonly terminated: boolean;
}

const defaultDefer = (task: () => void) => void setTimeout(task, 0);

/**
 * The real worker runner on the calling thread, behind the {@link SimWorkerLike} interface, for app
 * specs and the worker's own tests (no module worker in jsdom or Node). Messages are structured
 * clones delivered later, as `postMessage` would; a `SharedArrayBuffer` is shared, transferred
 * buffers are moved. Not for the game: there the engine never runs on the main thread (ADR 0011 §1).
 */
export function createInProcessSimWorker(options: InProcessSimWorkerOptions = {}): InProcessSimWorker {
  const defer = options.defer ?? defaultDefer;
  let handlers: SimWorkerHandlers | null = null;
  let terminated = false;
  const runner = new SimWorkerRunner(
    {
      post: (message, transfer = []) => {
        if (terminated) return;
        const copy = structuredClone(message, { transfer: [...transfer] });
        defer(() => {
          if (!terminated) handlers?.message(copy);
        });
      },
    },
    {
      isolated: options.isolated ?? true,
      sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
      littleEndian: platformIsLittleEndian(),
      clock: options.clock ?? performanceClock,
      schedule: defer,
      engine: options.engine,
      maxSlotBytes: options.maxSlotBytes,
    },
  );
  return {
    runner,
    get terminated() {
      return terminated;
    },
    postMessage(message, transfer) {
      if (terminated) return;
      const copy = structuredClone(message, { transfer: [...transfer] });
      defer(() => {
        if (terminated) return;
        try {
          runner.receive(copy);
        } catch {
          handlers?.error(); // what `self.onerror` would report
        }
      });
    },
    terminate() {
      terminated = true;
    },
    listen(next) {
      handlers = next;
    },
  };
}

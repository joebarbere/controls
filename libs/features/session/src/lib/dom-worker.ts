import type { SimWorkerLike } from '@controls/sim-protocol';

/**
 * Adapts a DOM `Worker` to the host's {@link SimWorkerLike}. `apps/game`'s worker factory wraps the
 * literal `new Worker(new URL(…), { type: 'module' })` with it (ADR 0011 §10): the constructor must
 * stay literal there for the build to bundle the worker, so only the adapter lives here.
 */
export function fromDomWorker(worker: Worker): SimWorkerLike {
  return {
    postMessage: (message, transfer) => worker.postMessage(message, [...transfer]),
    terminate: () => worker.terminate(),
    listen: (handlers) => {
      worker.onmessage = (event: MessageEvent) => handlers.message(event.data);
      worker.onerror = (event: ErrorEvent) => {
        event.preventDefault(); // reported as a crash, not as an uncaught page error
        handlers.error();
      };
      worker.onmessageerror = () => handlers.messageError();
    },
  };
}

/*
 * The host's view of a sim worker (ADR 0011 §10): what `SimHost` (feature-session) drives, whether
 * it is the real module worker (`apps/game`'s factory adapts a DOM `Worker`), the in-process one
 * (`@controls/sim-worker`, for app specs) or a spec's fake. Types only: features never import the
 * worker, and the worker's types never name the DOM.
 */

/** The callbacks a worker delivers to its host. */
export interface SimWorkerHandlers {
  /** A message from the worker (parse it: it is untrusted data until it passes `WorkerToHost`). */
  message(data: unknown): void;
  /** `onerror`: an uncaught error in the worker (or it failed to load). Never the worker's text. */
  error(): void;
  /** `onmessageerror`: a message that couldn't be deserialised. */
  messageError(): void;
}

/** A sim worker as the host sees it. */
export interface SimWorkerLike {
  /** `postMessage(message, transfer)`. */
  postMessage(message: unknown, transfer: readonly ArrayBuffer[]): void;
  /** Kills the worker at once; nothing more is delivered. */
  terminate(): void;
  /** Sets the handlers. Called once, before the first `postMessage`. */
  listen(handlers: SimWorkerHandlers): void;
}

/** Makes a new worker. `apps/game` provides one around the literal module-worker constructor. */
export type SimWorkerFactory = () => SimWorkerLike;

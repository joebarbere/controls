import { performanceClock, type WorkerClock } from './pacing/worker-clock';
import { platformIsLittleEndian, SimWorkerRunner } from './runner';

/** The parts of a dedicated worker's global scope the entry uses. */
export interface WorkerScope {
  readonly crossOriginIsolated?: boolean;
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  addEventListener(type: 'messageerror', listener: (event: MessageEvent) => void): void;
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  addEventListener(type: 'unhandledrejection', listener: (event: PromiseRejectionEvent) => void): void;
  addEventListener(type: 'securitypolicyviolation', listener: (event: SecurityPolicyViolationEvent) => void): void;
}

/**
 * Yields to the message queue through a `MessageChannel` (ADR 0011 §4): a posted message runs
 * after every message already queued, unlike a microtask, and isn't clamped like a nested `setTimeout`.
 */
export function messageChannelScheduler(): (task: () => void) => void {
  const channel = new MessageChannel();
  const tasks: (() => void)[] = [];
  channel.port1.onmessage = () => tasks.shift()?.();
  return (task) => {
    tasks.push(task);
    channel.port2.postMessage(null);
  };
}

/**
 * Starts the sim worker on `scope` (the module worker's `self`): wires messages to a
 * {@link SimWorkerRunner}, and turns an uncaught error, an unhandled rejection, a message that
 * can't be deserialised and any CSP violation in this scope into an `error` message. Violations
 * fire only on the worker's own scope, so the page can't see them without this listener.
 */
export function startSimWorker(scope: WorkerScope, clock: WorkerClock = performanceClock): SimWorkerRunner {
  const runner = new SimWorkerRunner(
    { post: (message, transfer = []) => scope.postMessage(message, [...transfer]) },
    {
      isolated: scope.crossOriginIsolated === true,
      sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
      littleEndian: platformIsLittleEndian(),
      clock,
      schedule: messageChannelScheduler(),
    },
  );
  scope.addEventListener('message', (event) => runner.receive(event.data));
  scope.addEventListener('messageerror', () => runner.fail('invalid-message', 'A message could not be deserialised.'));
  scope.addEventListener('error', () => runner.fail('engine-threw', 'An uncaught error in the sim worker.'));
  scope.addEventListener('unhandledrejection', () =>
    runner.fail('engine-threw', 'An unhandled rejection in the sim worker.'),
  );
  scope.addEventListener('securitypolicyviolation', (event) =>
    runner.fail('csp-violation', `The worker hit the CSP: ${event.violatedDirective}.`),
  );
  return runner;
}

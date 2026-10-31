import { createWorld } from '@controls/save-format';
import { parseWorkerMessage, SIM_PROTOCOL_VERSION, type WorkerToHost } from '@controls/sim-protocol';
import { messageChannelScheduler, startSimWorker, type WorkerScope } from './entry';
import { createInProcessSimWorker } from './in-process';
import { performanceClock, WorkerDiagnostics } from './pacing/worker-clock';

/*
 * The worker entry (ADR 0011 §10): its scope wiring (messages, uncaught errors, unhandled
 * rejections, undeserialisable messages and CSP violations in the worker's own scope become `error`
 * messages) and the in-process worker that app specs use.
 */

type Listener = (event: never) => void;

/** A fake dedicated-worker scope that records what the entry posts. */
function fakeScope(isolated = true) {
  const listeners = new Map<string, Listener>();
  const posted: WorkerToHost[] = [];
  const scope: WorkerScope = {
    crossOriginIsolated: isolated,
    postMessage: (message) => {
      const parsed = parseWorkerMessage(message);
      if (parsed === null) throw new Error('invalid message');
      posted.push(parsed);
    },
    addEventListener: (type: string, listener: Listener) => void listeners.set(type, listener),
  } as WorkerScope;
  const fire = (type: string, event: object) => (listeners.get(type) as (event: object) => void)(event);
  return { scope, posted, fire, listeners };
}

const init = {
  type: 'init',
  protocol: SIM_PROTOCOL_VERSION,
  transport: 'sab',
  start: { kind: 'world', world: createWorld({ seed: 1 }), firstSeq: 0 },
};

describe('startSimWorker', () => {
  it('listens for messages, errors, rejections, deserialisation failures and CSP violations', () => {
    const { scope, listeners } = fakeScope();
    startSimWorker(scope);
    expect([...listeners.keys()].sort()).toEqual([
      'error',
      'message',
      'messageerror',
      'securitypolicyviolation',
      'unhandledrejection',
    ]);
  });

  it('starts on init, reading isolation from its own scope', () => {
    const isolated = fakeScope(true);
    startSimWorker(isolated.scope);
    isolated.fire('message', { data: init });
    expect(isolated.posted[0]).toMatchObject({ type: 'ready', transport: 'sab', isolated: true });
    const plain = fakeScope(false);
    startSimWorker(plain.scope);
    plain.fire('message', { data: init });
    expect(plain.posted[0]).toMatchObject({ type: 'ready', transport: 'message', isolated: false });
  });

  it.each([
    ['error', {}, 'engine-threw'],
    ['unhandledrejection', {}, 'engine-threw'],
    ['messageerror', {}, 'invalid-message'],
    ['securitypolicyviolation', { violatedDirective: 'script-src' }, 'csp-violation'],
  ] as const)('turns %s into error %s', (type, event, code) => {
    const { scope, posted, fire } = fakeScope();
    startSimWorker(scope);
    fire('message', { data: init });
    fire(type, event);
    expect(posted.at(-1)).toMatchObject({ type: 'error', code });
    if (code === 'csp-violation')
      expect(posted.at(-1)).toMatchObject({ message: expect.stringContaining('script-src') });
  });
});

describe('messageChannelScheduler', () => {
  it('runs tasks after the current one, in order', async () => {
    const schedule = messageChannelScheduler();
    const order: number[] = [];
    const done = new Promise<void>((resolve) => {
      schedule(() => order.push(1));
      schedule(() => {
        order.push(2);
        resolve();
      });
    });
    order.push(0);
    await done;
    expect(order).toEqual([0, 1, 2]);
  });
});

describe('createInProcessSimWorker', () => {
  it('runs the real runner behind the host interface, and goes silent once terminated', async () => {
    const worker = createInProcessSimWorker();
    const received: unknown[] = [];
    let errors = 0;
    worker.listen({
      message: (data) => received.push(data),
      error: () => errors++,
      messageError: () => undefined,
    });
    worker.postMessage(init, []);
    await vi.waitFor(() => expect(received.length).toBeGreaterThanOrEqual(2));
    expect(parseWorkerMessage(received[0])).toMatchObject({ type: 'ready', isolated: true });
    expect(worker.runner.state).toBe('running');
    expect(worker.terminated).toBe(false);
    worker.terminate();
    const count = received.length;
    worker.postMessage({ type: 'advance', tick: 10 }, []);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).toHaveLength(count);
    expect(worker.terminated).toBe(true);
    expect(errors).toBe(0);
  });

  it('reports what self.onerror would for a runner that throws', () => {
    const tasks: (() => void)[] = [];
    const worker = createInProcessSimWorker({ defer: (task) => tasks.push(task) });
    let errors = 0;
    worker.listen({ message: () => undefined, error: () => errors++, messageError: () => undefined });
    vi.spyOn(worker.runner, 'receive').mockImplementation(() => {
      throw new Error('boom');
    });
    worker.postMessage({ type: 'stop' }, []);
    tasks.shift()?.();
    expect(errors).toBe(1);
  });
});

describe('jitless Zod', () => {
  it('is configured by the module the worker entry imports first', async () => {
    const { z } = await import('zod');
    await import('./jitless');
    expect(z.config().jitless).toBe(true);
  });
});

describe('WorkerDiagnostics', () => {
  it('averages chunks over a second of its clock', () => {
    let now = 0;
    const diagnostics = new WorkerDiagnostics({ now: () => now });
    expect(diagnostics.chunk(2, 10, 1)).toBe(false);
    diagnostics.throttled();
    now = 1_000;
    expect(diagnostics.chunk(2, 10, 0)).toBe(true);
    expect(diagnostics.current).toMatchObject({
      lastSolveMs: 2,
      maxSolveMs: 2,
      ticksPerSecond: 20,
      solveCount: 1,
      throttledPublishes: 1,
      busyFraction: 4 / 1_000,
      meanTickUs: 200,
    });
    now = 2_000;
    expect(diagnostics.roll()).toBe(true);
    expect(diagnostics.current.meanTickUs).toBe(0);
    expect(performanceClock.now()).toBeGreaterThan(0);
  });
});

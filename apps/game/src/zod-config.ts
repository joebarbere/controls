import { z } from 'zod';

/*
 * Imported first by `main.ts` (ADR 0011 §10, plan P2 follow-up "A CSP violation on every start"). Zod
 * 4 probes for `eval` (`new Function('')`, caught) the first time it compiles a schema, which the
 * CSP's `script-src` without `'unsafe-eval'` reports as a `securitypolicyviolation` on every start.
 * Jitless mode skips the probe and the compiled fast path. The sim worker does the same in its entry.
 */
z.config({ jitless: true });

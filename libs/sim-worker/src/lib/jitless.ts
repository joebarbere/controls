import { z } from 'zod';

/*
 * Imported first by the worker entry (ADR 0011 §10). Zod 4 probes for `eval` (`new Function('')`,
 * caught) the first time it compiles a schema, which the CSP's `script-src` without
 * `'unsafe-eval'` reports as a `securitypolicyviolation`. Jitless mode skips the probe and the
 * compiled fast path; the interpreted parse is plenty for the protocol's messages.
 */
z.config({ jitless: true });

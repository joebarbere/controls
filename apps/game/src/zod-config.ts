/*
 * Loaded as the build's `polyfills` entry, a separate script that runs before `main` and every chunk
 * (ADR 0011 §10, plan P2 follow-up "A CSP violation on every start"). Zod 4 probes for `eval`
 * (`new Function('')`, caught) when it builds an object schema, and the CSP's `script-src` without
 * `'unsafe-eval'` reports that as a `securitypolicyviolation`. Jitless mode skips the probe and the
 * compiled fast path.
 *
 * This sets Zod's global config (`globalThis.__zod_globalConfig`, read by `zod/v4/core` when it loads)
 * without importing Zod. Calling `z.config()` from `main.ts` is not enough: since the P4 lazy split,
 * Zod and module-level schemas live in a shared chunk that ES module order evaluates before `main`'s
 * body, so schemas were built before the call. The sim worker is one bundle and calls `z.config` first.
 */
const g = globalThis as { __zod_globalConfig?: { jitless?: boolean } };
g.__zod_globalConfig = { ...g.__zod_globalConfig, jitless: true };

export {};

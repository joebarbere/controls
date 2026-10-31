// The module worker entry (ADR 0011 §10). `apps/game` constructs it with the literal
// `new Worker(new URL(…), { type: 'module' })` in its factory module; nothing imports this file.
// Jitless Zod first, before any schema compiles, so its eval probe never trips the CSP.
import './lib/jitless';
import { startSimWorker } from './lib/entry';

startSimWorker(self as unknown as Parameters<typeof startSimWorker>[0]);

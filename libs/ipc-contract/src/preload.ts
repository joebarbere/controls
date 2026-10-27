// Narrow entry for the sandboxed preload: constants + types only, no Zod (keeps preload.cjs tiny).
export * from './lib/channels';
export * from './lib/bridge';

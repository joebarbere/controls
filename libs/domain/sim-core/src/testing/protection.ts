import { AFCI_15, GFCI_20, PLUG_ON_20, PLUG_ON_2P_20 } from './plug-on';

/*
 * Helpers for F2.5 part 2's protection specs: the refs of the built-in fuse and breaker. Specs only.
 */

export const FUSE_1A = { id: 'fuse.emberlyn-5x20-fa-1a', version: 1 };
export const BREAKER = { id: 'breaker.saltmere-1p-15a', version: 1 };

/**
 * The engine models the protection sessions (`devices/protection/properties.spec.ts`, and for breakers
 * v2 `devices/protection/plug-on-properties.spec.ts`) put through the save-and-load and replay
 * properties, by model kind (the engine's parity guard checks every model is covered).
 */
export const PROTECTION_SESSION_REFS = Object.freeze({
  fuse: FUSE_1A,
  'breaker.thermalMagnetic': BREAKER,
  'breaker.plugOn1p': PLUG_ON_20,
  'breaker.plugOn2p': PLUG_ON_2P_20,
  'breaker.gfci1p': GFCI_20,
  'breaker.afci1p': AFCI_15,
});

export * from './lib/viewport-renderer';
export * from './lib/viewport-controller';
export * from './lib/geometry/din-rail';
export * from './lib/scene';
export * from './lib/geometry/fixtures';
export * from './lib/cameras/camera-math';
export * from './lib/input/input-actions';
export * from './lib/picking/selection';
export { markSelectable, selectableOf, findSelectables } from './lib/picking/picker';
export * from './lib/stats/frame-timer';
export * from './lib/geometry/props';
export * from './lib/geometry/devices';
export { WorldSync, entitySelectableId, applyTransform, type SyncResult } from './lib/world/world-sync';
export { FixtureSync, BENCH_FOCUS_ELEVATION_DEG } from './lib/world/fixture-sync';
export type { PickHit } from './lib/picking/picker';
export {
  SimOverlays,
  type OverlayGraph,
  type OverlayLegendState,
  type OverlayName,
  type OverlayTerminalRef,
  type SnapshotFeed,
} from './lib/overlays/sim-overlays';
export * from './lib/sim/overlay-scale';
export * from './lib/sim/overlay-steps';

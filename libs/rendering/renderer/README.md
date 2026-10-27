# renderer (`@controls/renderer`)

Framework-free Three.js r186 rendering (`type:rendering`). `ViewportRenderer` owns the `WebGPURenderer` (which falls back to WebGL2 by itself), the scene, the camera, the orbit controls and the animation loop. Angular hands it a canvas and sizes, and calls `dispose()` on teardown. P0 content is a procedurally built sub-panel with two TS35 DIN rails (`buildPanelScene`, `buildDinRailGeometry`, `buildBackplateGeometry`). Scene units are metres, built from integer millimetres.

Must not depend on Angular or Electron. May depend only on `type:rendering` and `type:domain` libs. Tests: `pnpm nx test renderer`.

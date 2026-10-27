# renderer (`@controls/renderer`)

Framework-free Three.js r186 rendering (`type:rendering`). It draws the world and never mutates it.

- `ViewportRenderer`: the `WebGPURenderer` (falls back to WebGL2 by itself; `forceWebGL` pins it), the animation loop and the dev-HUD stats. Angular hands it a canvas and sizes, and calls `dispose()` on teardown.
- `ViewportController`: everything except the GPU. Scene, camera, walk/work modes, input actions, BVH hover/selection (three-mesh-bvh) and overlays. Unit-tested in Node.
- Pure, lint-fenced modules (no `three`, DOM or clock): `snap/` (integer-mm DIN rail, backplate grid and wall-stud snapping with sourced constants; moves to `@controls/world-model` in F1.2), `cameras/camera-math`, `input/input-actions`, `picking/selection`, `stats/frame-timer`.
- P1 content is the demo sub-panel: a backplate and two TS35 DIN rails on a floor (`buildPanelScene`). Scene units are metres, converted from integer millimetres with `mm()` / `metresToMm()` from `@controls/units`.

Must not depend on Angular or Electron. May depend only on `type:rendering` and `type:domain` libs. Read [rendering caveats](../../../docs/caveats/rendering.md) first; design: [rendering architecture](../../../docs/architecture/rendering.md). Tests: `pnpm nx test renderer`.

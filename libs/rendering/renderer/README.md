# renderer (`@controls/renderer`)

Framework-free Three.js r186 rendering (`type:rendering`). It draws the world and never mutates it.

- `ViewportRenderer`: the `WebGPURenderer` (falls back to WebGL2 by itself; `forceWebGL` pins it), the animation loop and the dev-HUD stats. Angular hands it a canvas and sizes, and calls `dispose()` on teardown.
- `ViewportController`: everything except the GPU. Scene, camera, walk/work modes, input actions, BVH hover/selection (three-mesh-bvh) and overlays. Unit-tested in Node.
- `world/world-sync` draws world entities from snapshots by id (procedural, ref-counted prop recipes in `geometry/props`); `overlays/ghost` is the placement preview. Gestures leave as `ViewportIntent`s (`place`, `move`, `cancelPlacement`) for the workspace to run as Commands; the renderer never mutates the world.
- Pure, lint-fenced modules (no `three`, DOM or clock): `cameras/camera-math`, `input/input-actions`, `picking/selection`, `stats/frame-timer`. Snap and placement maths live in `@controls/world-model` (`snap/`), so scripts snap like the mouse.
- P1 content is the demo sub-panel: a backplate and two TS35 DIN rails on a floor (`buildPanelScene`). Scene units are metres, converted from integer millimetres with `mm()` / `metresToMm()` from `@controls/units`.

Must not depend on Angular or Electron. May depend only on `type:rendering` and `type:domain` libs. Read [rendering caveats](../../../docs/caveats/rendering.md) first; design: [rendering architecture](../../../docs/architecture/rendering.md). Tests: `pnpm nx test renderer`.

> Research snapshot gathered 2026-10-26 by a planning sub-agent for controls-development-plan.md. Versions, licences and figures were verified on that date; re-verify before relying on them.

I checked current versions directly against the npm registry, nodejs.org, the Electron releases feed and GitHub, so the numbers below are as of 2026-10-26.

# Research report: Electron + Angular + Three.js desktop simulator (2026-10-26)

## 1. Current versions

| Tech       | Version                                                       | Notes                                                                                                                                                                                                          |
| ---------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Electron   | **45.0.0** (2026-10-21), Chromium 156.0.8078.48, Node 24.22.0 | Electron supports the latest 3 majors (43–45). https://releases.electronjs.org                                                                                                                                 |
| Angular    | **22.2.3** core / 22.2.4 CLI                                  | 22.3 is in `next`. Angular has moved to one major per year.                                                                                                                                                    |
| Three.js   | **r186** (`three@0.186.1`, 2026-09-24)                        | https://github.com/mrdoob/three.js/releases                                                                                                                                                                    |
| Node       | **24.22.1 "Krypton" (Active LTS)**; 26.12.1 is Current        | Node 26 is due to enter LTS this month. Node 27 starts the new one-major-per-year scheme (https://infoq.com/news/2026/06/nodejs-release-changes).                                                              |
| TypeScript | **7.0.2** (Go-native compiler)                                | About 8–12x faster builds. The programmatic API arrives in 7.1 (beta now), so tools that use the TS API may still need the 6.x JS compiler side by side. https://infoq.com/news/2026/08/typescript-7-released/ |

**Angular's direction:** standalone components everywhere, signals as the reactivity model, **zoneless by default since v21**, OnPush as the default in v22, Signal Forms stable, Vitest as the default test runner, and the esbuild/Vite `@angular/build:application` builder. `zone.js` (0.16.3) is now opt-in.

**What this means for a game UI:** zoneless is a big win. Requestanimationframe (rAF) loops, pointer events and worker messages no longer trigger app-wide change detection, so you don't need `runOutsideAngular` everywhere. Drive the HUD, inspector panels and HMI widgets from signals that the sim updates at about 10–30 Hz, not every frame.

## 2. Angular + Electron integration

- **maximegris/angular-electron** is still maintained: 5.7k stars, last pushed 2026-09-04, and it currently ships Angular 22.1.4, Electron 44.1.1 and electron-builder 26.15.3. It's fine as a reference, but it lags upstream and has its own opinions.
- **nx-electron** 22.0.0 (Feb 2026) trails Nx **24.0.2**. I wouldn't depend on it.
- **electron-vite** 6.0.0 is solid for the main and preload processes but doesn't use Angular's builder.
- **Recommendation: roll your own.** Build the renderer with the Angular CLI (`ng build`, output loaded via a custom `app://` protocol). Bundle main and preload with esbuild or electron-vite. Glue it together in an Nx 24 or pnpm workspace.

**Packaging:**

- **electron-builder 26.18.0** (v27 is in alpha, ESM-only) has the widest target list. I confirmed in the source: NSIS, MSI, **MSIX/AppX**, dmg/pkg/zip with universal or arm64 builds, AppImage, deb/rpm (fpm), snap and **Flatpak**. It has built-in Azure signing (`azureSignOptions`) and notarization. It pairs with **electron-updater 6.8.11**, which reads GitHub Releases, supports differential (blockmap) updates and works with NSIS, dmg/zip and AppImage.
- **Electron Forge 8.0.1** (2026-09-29) is the official tool. It is now ESM-only, needs Node ≥22.17, its Vite plugin is stable, and `publish` was renamed to `release`. Its updater path is Squirrel plus **update.electronjs.org**, which is free but only covers public GitHub repos and macOS/Windows (no AppImage).
- **Verdict:** use **electron-builder + electron-updater** with GitHub Releases. For a game you want AppImage/Flatpak auto-update and NSIS differential updates, and Forge doesn't cover those as well.

**Signing realities:**

- **Apple:** Developer Program is US$99/yr. You need a Developer ID certificate plus notarization (`notarytool`) and the hardened runtime. Unsigned apps can't auto-update on macOS, because Squirrel.Mac requires signing.
- **Windows:** Azure Trusted Signing has been renamed **"Artifact Signing"** (https://azure.microsoft.com/pricing/details/artifact-signing/). Basic is 5,000 signatures/month and Premium 100,000. The pricing page didn't render the dollar amounts. It was historically about $9.99/mo Basic, so check the live page. Eligibility has historically been organisations in the US/CA/EU/UK and individual developers in the US/CA only. If you don't qualify, an OV/EV certificate on a hardware token costs roughly $200–500/yr. MSIX via the Microsoft Store is signed by the Store for free.
- **Linux:** no signing needed. Flathub does its own builds.

## 3. Three.js inside Angular

- **angular-three (ngt) 4.2.4** (2026-07-15) is maintained by one person (303 stars). Its peer dependencies are **`@angular/core >=20 <22` and `three <0.183`**, so it does not officially support Angular 22 or Three r186 today. That alone rules it out as a foundation.
- **Recommendation: plain imperative Three.js.** Have a `RendererService` own the `WebGPURenderer`/`WebGLRenderer`, the scene graph and the rAF loop. A thin `<sim-viewport>` component hands over its canvas and a ResizeObserver. With zoneless Angular nothing re-renders unless a signal changes. This keeps the renderer framework-agnostic and testable, and lets you lift it into a worker with `OffscreenCanvas` later.
- **WebGPU:** `three/webgpu` WebGPURenderer is production-grade. It uses TSL node materials, falls back automatically to WebGL2, and in r183 `PostProcessing` was renamed to `RenderPipeline` and `Clock` was replaced by `Timer` (https://threejs.org/manual/en/webgpurenderer). Chromium 156 enables WebGPU by default on Windows and macOS. On Linux, availability still depends on the driver and Vulkan setup, so detect `navigator.gpu` and keep the WebGL2 fallback. Benchmarks have shown WebGLRenderer sometimes faster, so measure both.

## 4. Game architecture

**ECS (npm versions, last activity):**

- **koota 0.6.6** (pmndrs, pushed 2026-10-18): trait-based, good query ergonomics, actively developed.
- **bitECS 0.4.0** (Dec 2025): SoA typed arrays, the fastest option, and naturally SharedArrayBuffer-friendly.
- **becsy 0.16.1**: multithreading ambitions, but niche.
- **miniplex 2.0.0**: object-based, stale since 2023.
- **Pick:** bitECS for sim-core if you want SharedArrayBuffer; koota if you value ergonomics. An electrical sim is mostly a graph or netlist solver, not thousands of moving entities. Keep the circuit model (nodes, conductors, devices, PLC scan) as plain TS data structures, and use ECS only for the 3D world objects.

**Threading:**

- Run the simulation (circuit solver, PLC ladder scan, fixed-timestep loop) in a **Web Worker** in the renderer. Use Comlink-style message passing for commands and a **SharedArrayBuffer** for hot state such as I/O tags, voltages and transform buffers.
- SharedArrayBuffer needs `crossOriginIsolated`. Set COOP/COEP headers on your custom `app://` protocol handler.
- Use **utilityProcess** only for Node-side work (file I/O, mod loading, heavy solves that must survive renderer reloads).

**Loop:** a fixed-timestep accumulator ("Fix Your Timestep") with sim at 60–120 Hz, PLC scans at a configurable cycle time, and render interpolation between snapshots.

**Picking:** **three-mesh-bvh 0.9.16** (2026-10-08) for raycasting terminals and wire endpoints, plus GPU ID-buffer picking for dense panels.

**Physics:** **Rapier 0.21.0** (`@dimforge/rapier3d-compat`) is good for rigid bodies such as DIN rails, doors and dropped tools. Cable sag is cheaper and more controllable as your own **Verlet/PBD rope**: 10–30 particles per wire, distance constraints and collision against BVH or capsules. Rendering is a `TubeGeometry` or instanced segments. Settled wires can be baked to static geometry.

**Save files:**

- JSON with `{schemaVersion, …}`, validated with Zod or Valibot (or JSON Schema via Ajv), and an ordered `migrations[n→n+1]` chain run on load. Keep the circuit netlist separate from the 3D layout. Write atomically (temp file then rename) in main.
- **Modding:** data-first packs (JSON device definitions + glTF models + ladder libraries) loaded from a user mods directory. If you allow scripts, run them in a sandboxed worker or QuickJS-WASM, never in Node.

## 5. Testing

- **Unit tests:** **Vitest 5.0.5**, Angular's default runner. Use Angular's builder integration, or `@analogjs/vitest-angular` 2.9.2 for library projects. Jest is legacy for Angular now.
- **sim-core:** pure Vitest. Property-based tests with fast-check are a good fit for the solvers.
- **E2E:** **Playwright 1.64.1** using `_electron.launch()` to drive the packaged app.
- **3D visual regression:**
  - Render deterministic scenes (fixed seed, fixed DPR, SwiftShader/WebGL2 in CI) and compare with `toHaveScreenshot` and a pixel threshold.
  - Also snapshot the scene graph or netlist as JSON, which is less brittle than pixels.

## 6. Open-source projects worth studying

- **Excalidraw**, **tldraw**, **draw.io desktop (jgraph/drawio-desktop, Electron)**: 2D editor architecture for the schematic and ladder editors.
- **OpenPLC Editor** (ladder semantics) and **Falstad CircuitJS** (MNA circuit solver).
- **three.js `examples/`**, **pmndrs projects** (koota examples).
- **Veloren**-style ECS writeups.
- **Bitburner** and **Shapez.io**, both shipped commercially on Steam via Electron, for save-file and modding structure.
- **VS Code**, for IPC and process-model patterns.

## 7. Security

- Keep the defaults: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`.
- Serve from a custom `app://` protocol, not `file://`.
- Preload exposes a **narrow, typed** API via `contextBridge.exposeInMainWorld('api', {saveGame, loadGame, listMods…})`. Use `ipcRenderer.invoke` / `ipcMain.handle`, validate every payload with Zod in main, never expose raw `ipcRenderer`, and check `event.senderFrame.url`.
- CSP: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'`. Angular needs inline styles unless you use nonces.
- Block `will-navigate` and `setWindowOpenHandler`.
- Flip Electron Fuses: disable `RunAsNode` and `NODE_OPTIONS`, and enable ASAR integrity.

## Recommended stack

Electron 45 · Angular 22 (zoneless, signals, `@angular/build`) · Three r186 (WebGPURenderer with WebGL2 fallback) · TypeScript 7.0 (keep 6.x for any tool that needs the TS API) · Node 24 LTS for tooling (move to 26 once it's LTS) · bitECS or koota · three-mesh-bvh · custom Verlet cables plus Rapier for rigid bodies · Zod-validated JSON saves · Vitest 5 + Playwright 1.64 · electron-builder 26 + electron-updater via GitHub Releases · Artifact Signing (Windows) + notarization (macOS).

**Monorepo: Nx 24 or pnpm workspaces.**

```
apps/
  desktop/          # Electron main + preload (esbuild), protocol, IPC handlers, updater, fuses
  game-ui/          # Angular 22 app: shell, menus, HUD, inspectors, HMI runtime
  desktop-e2e/      # Playwright _electron tests + screenshot baselines
libs/
  sim-core/         # pure TS, no DOM: netlist, MNA solver, devices, PLC/ladder interpreter, fixed-step loop
  sim-worker/       # Worker entry, SAB layout, command protocol (typed)
  renderer/         # Three.js scene, loaders, picking (BVH), cable verlet, camera; framework-free
  ui/               # Angular components: schematic editor, ladder editor, HMI widgets (canvas/SVG)
  ipc-contract/     # shared Zod schemas + TS types for preload API
  save-format/      # schemas, versioned migrations, fixtures
  content/          # device definitions, glTF assets, scenarios; mod-pack format
```

**Why this layout:**

- `sim-core` and `renderer` have no Angular dependency, so they're fast to test and portable (a web demo or headless CI sims are possible).
- Angular is just the UI shell.
- The IPC contract and save format are single sources of truth shared by main and renderer.
- Nx caching keeps builds fast as the repo grows.

Two follow-ups are worth doing before you commit money: check the live Artifact Signing price and whether you're eligible as an individual, and test WebGPU on your Linux GPU drivers.

Sources: [Electron releases](https://releases.electronjs.org), [Electron timelines](https://electronjs.org/de/docs/latest/tutorial/electron-timelines), [endoflife.ai Electron](https://endoflife.ai/article-electron-42-eol), [endoflife.ai Angular](https://endoflife.ai/article-angular-lts), [Mungomash Angular versions](https://mungomash.com/software/angular/versions/), [Ionic + Angular 22 Vitest/zoneless](https://dev.to/the-modern-web/modernizing-ionic-8-angular-22-moving-from-karma-zonejs-eslint-v8-to-vitest-zoneless-flat-nh2), [Angular 22 release write-up](https://businesstechnavigator.com/news/angular-v22-released-signals-first-onpush-2026), [Three.js WebGPURenderer manual](https://threejs.org/manual/en/webgpurenderer), [Three r183 changes](https://app.cinevva.com/tr/news/2026-03-18-threejs-r183-render-pipeline), [WebGPU benchmark](https://ics.media/en/entry/250501/), [gpuweb implementation status](https://github.com/gpuweb/gpuweb/wiki/implementation-status), [TypeScript 7 (InfoQ)](https://infoq.com/news/2026/08/typescript-7-released/), [TS 7 RC](https://visualstudiomagazine.com/articles/2026/06/22/typescript-7-0-rc-moves-microsofts-go-rewrite-into-the-mainline-compiler.aspx), [TS 7 gaps](https://alternativeto.net/news/2026/7/typescript-7-0-launches-with-go-based-compiler-and-up-to-12x-faster-performance/), [Node release changes](https://infoq.com/news/2026/06/nodejs-release-changes), [Node 26](https://www.inmotionhosting.com/support/news/nodejs-v26-released/), [Artifact Signing pricing](https://azure.microsoft.com/pricing/details/artifact-signing/), [Electron Forge 8 release](https://github.com/electron/forge/releases), [Why Electron Forge](https://www.electronforge.io/core-concepts/why-electron-forge), [OpenReplay packaging guide](https://blog.openreplay.com/packaging-distributing-electron-apps/), [maximegris/angular-electron](https://github.com/maximegris/angular-electron), [angular-three](https://github.com/angular-threejs/angular-three), [koota](https://github.com/pmndrs/koota), [bitECS](https://github.com/NateTheGreatt/bitECS), [miniplex](https://github.com/hmans/miniplex), npm registry (all package versions above).

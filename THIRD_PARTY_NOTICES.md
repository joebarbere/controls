# Third-party notices

Controls is released under the [MIT licence](LICENSE). It depends on, and ships, the third-party components listed below. Each keeps its own licence.

**Policy** (see [ADR 0003](docs/decisions/0003-licence-policy.md)): runtime dependencies and adapted code must be MIT, BSD, ISC, Apache-2.0 or similarly permissive, and must be listed here. GPL, AGPL and LGPL projects are reference-only: we read their documentation and design and reimplement from papers and specs, never copying or translating their code.

`docs-keeper` and `release-engineer` keep this file current. Add a row in the same PR that adds a runtime dependency or adapts code.

## Runtime dependencies shipped in the desktop app

| Component                                                     | Licence    | Use                                                                                                                                            |
| ------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| [Electron](https://www.electronjs.org/)                       | MIT        | Desktop shell. Bundles Chromium and Node.js, whose own licences are shipped by electron-builder as `LICENSES.chromium.html` alongside the app. |
| [Angular](https://angular.dev/)                               | MIT        | UI framework (`@angular/*`)                                                                                                                    |
| [RxJS](https://rxjs.dev/)                                     | Apache-2.0 | Angular dependency                                                                                                                             |
| [tslib](https://github.com/microsoft/tslib)                   | 0BSD       | TypeScript runtime helpers                                                                                                                     |
| [Three.js](https://threejs.org/)                              | MIT        | 3D rendering                                                                                                                                   |
| [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) | MIT        | BVH picking for hover and selection in the 3D viewport (`@controls/renderer`)                                                                  |
| [Zod](https://zod.dev/)                                       | MIT        | Schema validation (IPC payloads; later saves, catalogue, commands)                                                                             |
| [electron-updater](https://www.electron.build/auto-update)    | MIT        | Auto-update from GitHub Releases                                                                                                               |

Build and test tooling (Nx, TypeScript, esbuild, Vite, Vitest, fast-check, Playwright, ESLint, Prettier, electron-builder) is not shipped in the app and is not listed.

## Adapted code

None yet. When code is adapted from a permissive project (for example the sparse LU from `@spice-ts/core` or `brownout`, both MIT, planned for P2), add the project, licence, the files it went into and the original copyright notice here.

## Reference-only projects (no code used)

These are studied for design ideas only. Listed so the boundary is explicit: Falstad CircuitJS1 (GPL-2.0), OpenPLC Editor v4, STruC++ and Beremiz/MatIEC (GPL), Studomate (AGPL-3.0), SimulIDE (AGPL-3.0), Qucs-S and Xyce (GPL), Logisim-evolution (GPL-3.0), ScadaBR (GPL), shapez.io (GPL). See plan §5 for the full table.

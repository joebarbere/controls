# ADR 0010: Wire-routing spike findings

**Status:** Accepted (F1.10). The spike code lives on the `spike/wire-routing` branch (commit `9a6761c`) and is **never merged**.
**Date:** 2026-10-28 (Phase 1)
**Sources:** plan §4.2, §4.9, §6 P3 (F3.2); [phase 1 plan](../../plans/phase-1-game-shell.md) F1.10 and the risk "Spike code leaks into `main`"; [ADR 0006](0006-command-system.md) (Commands and input actions); [ADR 0007](0007-world-document-v1.md) (integer mm, determinism); [rendering caveats](../caveats/rendering.md)

## Context

Plan §4.9 names wire routing as the game's highest UX risk. The flow it describes has five steps: pick the wire from the spool, click the source terminal, optionally click waypoints or snap to a duct, click the destination terminal, then do the termination steps for the difficulty (automatic at Trainee). The rope sags with Verlet physics while live, then bakes to a static mesh. P3 builds this for real (F3.2). F1.10 is a throwaway prototype, built to measure the risky parts first: frame cost, clicks and time per connection, hit-target sizes, clipping, and particle density.

## What the spike built

`?spike=wire` in the web harness adds the spike to the workshop backplate. It hard-codes the layout and keeps all wire state in the renderer; it emits no Commands. That breaks the renderer invariants on purpose, which is one reason it is never merged.

- **Fake layout** (game-design guesses, unsourced): 40 feed-through terminal blocks at a 6.2 mm pitch on DIN rail 1 (80 terminals, screws 4 mm across); five 45 mm contactors on rail 2 (30 terminals at a 15 mm pitch); three horizontal 40 × 60 mm wiring ducts and a right-hand riser duct. That makes 110 terminals.
- **The flow:** five spool buttons, chosen once and kept for following wires. Click a source screw; click waypoints, which land free on the plate or snap to a duct's centreline; click the destination screw. With **Auto-route via ducts** ticked, the source and destination clicks alone produce a duct path: out of the clamp, into the nearest duct, along it, through the riser if the ducts differ, and up to the other clamp. At **Trainee**, termination is automatic. At **Realistic**, six prompts follow: strip, ferrule and torque at each end. Esc cancels a route and Backspace removes the last waypoint. A **drill** mode marks ten fixed pairs (green is the source, blue the destination) for the manual timing protocol below.
- **Verlet rope** (`spike/rope.ts`): the rope is held in typed arrays, so a step allocates nothing. Particles are spaced 15 mm apart with 3 % slack. Each frame runs 2 substeps of 1/120 s, with 12 constraint passes and 0.98 damping. Two constraints keep the rope in place: z ≥ conductor radius (1.4 mm) keeps it off the plate, and each duct span is clamped to the duct's interior box. Pins sit at the clamp entry, at a 12 mm lead-out along the clamp's exit direction, and at each waypoint. A rope counts as settled after 10 steps in which no particle moves more than 0.01 mm (capped at 600 steps, 5 s), and then it bakes.
- **Three bake strategies, switchable:**
  - `mesh`: one `Mesh` per wire with a `TubeGeometry` through a centripetal Catmull-Rom (6 radial segments).
  - `batched`: one `BatchedMesh` holding the same tubes, with a colour per instance.
  - `instanced`: one `InstancedMesh` of open 6-sided unit cylinders, one instance per rope segment, with a colour per instance.

  Live ropes always use a second `InstancedMesh` of segments, rewritten every frame.

- **Picking:** a terminal is the nearest screw centre within R CSS px of the pointer, in screen space (R = 12 px). A wire is the nearest projected centreline within 6 px (brute force, for measurement only).
- **Harness:** `apps/game-e2e/playwright.spike.config.mts` and `src/spike/wire-spike.spike.ts` drive the measurements through `window.__wireSpike`; `src/spike/gpuprobe.mjs` reports which adapter each launch mode gets.
- **Dependencies:** none were added. `TubeGeometry`, `CatmullRomCurve3`, `BatchedMesh` and `InstancedMesh` are all three.js core, so `THIRD_PARTY_NOTICES.md` needs no row.

## Measuring environment (read this before the numbers)

- **Machine:** the developer's desktop, which was busy throughout. It runs Fedora 44 (Linux 7.2) on 12 threads with an **AMD Radeon RX 7600 XT, a discrete RDNA3 GPU**. Other worktrees were running builds and E2E at the same time, and the load average ranged from 1 to 21 over the runs. Expect noise of a few milliseconds, especially in p95 and max.
- **Real-GPU runs:** Playwright's Chromium 156 in new headless mode (`channel: 'chromium'`) with `--use-angle=vulkan --enable-unsafe-webgpu --enable-features=Vulkan --enable-gpu --ignore-gpu-blocklist`. WebGL2 ran on ANGLE over Vulkan (RADV) and WebGPU on Dawn over Vulkan; the adapter strings were checked with `gpuprobe.mjs`. **VSync and the frame-rate limit were off** (`--disable-gpu-vsync --disable-frame-rate-limit`), so frame intervals show headroom instead of sitting at a 16.7 ms cap. The canvas was 1920 × 1080 at DPR 1, framed by the default backplate focus (the main-menu view, where the canvas fills the window).
- **SwiftShader runs:** headless Chromium with its defaults: `--use-angle=swiftshader` for WebGL2 and SwiftShader's Vulkan fallback adapter for WebGPU. This is what GPU-less CI has. At 1080p, SwiftShader on this loaded machine rendered the bare scene at about 2.4 fps (WebGL2, about 420 ms a frame), too few frames per 3 s window to compare anything. So the SwiftShader table below is at **640 × 360**.
- **Metrics:**
  - **Frame** is the `requestAnimationFrame` interval, as mean and p95 over a 3 s window.
  - **Sim** is the main-thread time for the rope simulation plus the instance-matrix writes.
  - **Bake** is the total time to bake all N wires.

  GPU time wasn't measured on its own (no timestamp queries).

- **What the numbers don't tell us:**
  - **The plan §4.9 budget (60 fps at 1080p with a 500-device plant on a 2020-era integrated GPU) is unmeasured.** An RX 7600 XT has several times the fill rate and bandwidth of a 2020 iGPU, so the real-GPU numbers are a lower bound on GPU cost.
  - The CPU-side numbers (rope simulation, bake time, per-draw cost) carry over better, though a 2020 laptop CPU will be slower.
  - Headless WebGL2 on ANGLE over Vulkan showed a high baseline p95 (about 12 ms against WebGPU's 2.5 ms on the same GPU). That's probably the headless readback path plus machine load, not the wires, so compare each row with its own run's baseline.
  - SwiftShader numbers say what CI can run, not what players see.

## Results

### Frame time, real GPU (RX 7600 XT, 1920 × 1080, uncapped)

Each cell gives frame mean / p95 in ms, then sim mean in ms in brackets. Auto-duct routes average **70.9 particles per wire** at 15 mm spacing (about 1 m of wire each), so N = 200 means 14 176 particles.

| Scene                  | WebGPU             | WebGL2 (ANGLE/Vulkan) |
| ---------------------- | ------------------ | --------------------- |
| Baseline (no wires)    | 1.6 / 2.5          | 5.6 / 12.6            |
| 10 live ropes          | 2.1 / 3.1 (0.6)    | 8.0 / 21.1 (1.3)      |
| 50 live ropes          | 4.3 / 5.5 (2.6)    | 12.1 / 29.0 (6.2)     |
| 200 live ropes         | 12.2 / 13.8 (10.2) | 21.4 / 37.2 (16.8)    |
| 10 baked, `mesh`       | 1.7 / 2.7          | 5.4 / 12.3            |
| 50 baked, `mesh`       | 1.7 / 2.8          | 6.4 / 14.7            |
| 200 baked, `mesh`      | 2.2 / 3.6          | 7.5 / 15.5            |
| 10 baked, `batched`    | 1.8 / 2.9          | 5.6 / 13.4            |
| 50 baked, `batched`    | 1.7 / 2.6          | 5.1 / 12.3            |
| 200 baked, `batched`   | 1.7 / 2.7          | 5.7 / 13.8            |
| 10 baked, `instanced`  | 1.9 / 3.1          | 5.3 / 15.1            |
| 50 baked, `instanced`  | 2.0 / 3.4          | 5.9 / 13.3            |
| 200 baked, `instanced` | 1.8 / 2.9          | 5.0 / 11.0            |

Bake cost for 200 wires (real GPU, total):

| Strategy    | WebGPU run | WebGL2 run | Per wire         |
| ----------- | ---------- | ---------- | ---------------- |
| `mesh`      | 47 ms      | 122 ms     | 0.24 to 0.6 ms   |
| `batched`   | 50 ms      | 124 ms     | 0.25 to 0.6 ms   |
| `instanced` | 1.2 ms     | 2.0 ms     | 0.006 to 0.01 ms |

`TubeGeometry` construction dominates the `mesh` and `batched` bakes. `instanced` only writes 16 floats per segment.

### Frame time, SwiftShader (640 × 360)

Each cell gives frame mean / p95 in ms, then sim mean in ms in brackets.

| Scene                            | WebGPU (SwiftShader)      | WebGL2 (SwiftShader) |
| -------------------------------- | ------------------------- | -------------------- |
| Baseline (no wires)              | 17.1 / 19.6               | 77.6 / 229           |
| 10 live ropes                    | 17.0 / 21.1 (0.8)         | 122 / 362 (0.8)      |
| 50 live ropes                    | 16.9 / 18.6 (3.1)         | 86 / 239 (4.6)       |
| 200 live ropes                   | 17.1 / 17.7 (10.8)        | 201 / 1813 (13.3)    |
| 10 / 50 / 200 baked, `mesh`      | 17.2 / 16.8 / 16.7 (mean) | 57 / 80 / 129 (mean) |
| 10 / 50 / 200 baked, `batched`   | 17.2 / 16.8 / 16.8 (mean) | 77 / 92 / 289 (mean) |
| 10 / 50 / 200 baked, `instanced` | 17.1 / 16.9 / 16.7 (mean) | 84 / 75 / 140 (mean) |

- **SwiftShader WebGPU stayed at the 60 Hz cap**, because the uncapping flags don't apply to it. Every scene held 60 fps at 640 × 360, including 200 live ropes (10.8 ms of sim), so this table can't rank the strategies.
- **The SwiftShader WebGL2 project ran first, during the heaviest load** (load average about 20). Its baseline alone was 78 ms with a p95 above 200 ms, so the differences between its rows are noise.
- What these runs do show: every flow runs on both of the backends CI has.

### Particles per wire

The same 50 auto-duct wires were run live at three particle spacings (real GPU, sim ms per frame):

| Spacing | Particles per wire | Sim, WebGPU run | Sim, WebGL2 run |
| ------- | ------------------ | --------------- | --------------- |
| 10 mm   | 105.1              | 3.9 ms          | 7.2 ms          |
| 15 mm   | 70.9               | 2.9 ms          | 4.8 ms          |
| 25 mm   | 45.7               | 1.9 ms          | 3.0 ms          |

In Node (`rope.spec.ts`, same machine), 200 ropes at 15 mm cost 8.8 ms per frame for 2 substeps × 12 passes, about 0.3 µs per particle per substep. The cost is linear in particles. Zoomed about 2.5× from the default framing, 15 mm and 25 mm baked wires look almost the same; 25 mm shows angular corners where wires turn into the riser. The 6-sided segments read as round at that distance. So spacing is a cost and close-up-quality choice, not a correctness one; 15 mm was the spike's default.

A free 300 mm span with 3 % slack sags 55 mm and needs 185 steps (1.5 s at 120 Hz) to settle. That is too much sag for panel wiring, which is dressed fairly taut. Slack has to depend on context.

### Clicks and seconds per connection

The scripted runs (Playwright, real GPU, workspace canvas 1594 × 833) aim at the projected screw centres, so they never miss. The times are **automation latency, not human times**: Playwright round trips plus a frame or two per click. Treat them only as a floor.

| Mode                                                            | Clicks per connection             | Scripted seconds |
| --------------------------------------------------------------- | --------------------------------- | ---------------- |
| Trainee, manual via a duct (src, duct, duct, dst)               | 4 (+1 for the first wire's spool) | 0.35 to 0.49     |
| Trainee, auto-route                                             | 2                                 | 0.10 to 0.18     |
| Realistic, auto-route (+6 termination prompts)                  | 8                                 | 0.60 to 0.93     |
| Drill (10 pairs, Trainee auto, includes the move to the source) | 2.0                               | 0.4 mean         |

Human seconds per connection are **unmeasured**; run the [manual protocol](#manual-protocol-seconds-per-connection) to get them.

### Hit targets

| View                                                   | Terminal-block pitch | Screw diameter | Contactor pitch |
| ------------------------------------------------------ | -------------------- | -------------- | --------------- |
| Default work-mode framing, workspace canvas 1594 × 833 | 4.3 px               | 2.8 px         | 10.6 px         |
| Default framing, full 1920 × 1080 canvas               | 5.6 px               | 3.6 px         | 13.8 px         |
| Zoomed in to the orbit limit over the rail             | 61.7 px              | 39.8 px        | 228.5 px        |

- **Nearest-within-R picking is right only up to half the pitch.** At a 4.3 px pitch, clicks 0, 1.1 and 1.9 px off the screw picked it, and 2.4 px picked the neighbour. With R = 12 px, a click near the row always picks _something_. At the default framing, though, a click slightly off target picks the neighbour.
- So **6.2 mm terminals can't be targeted at the default framing.** WCAG 2.2's minimum target size (2.5.8) is 24 × 24 CSS px. Meeting it for a 6.2 mm terminal-block pitch takes about 5.6× zoom from the default framing, which work mode allows (it reaches 62 px). The 15 mm contactor pitch needs about 2.3×.
- An R larger than half the pitch only helps if the terminal that would be picked is shown before the click; the spike shows a yellow marker. Which R and zoom feel right to a person is unmeasured; the manual protocol asks for both.

### Clipping and occlusion

Clip report after 200 auto-duct wires settled and baked (identical on both real-GPU runs):

| Check                                                                      | Result                       |
| -------------------------------------------------------------------------- | ---------------------------- |
| Centreline samples behind the plate                                        | 0 of 14 176                  |
| Tube curve (4 samples per segment) dipping behind the plate                | 0                            |
| Samples more than 1 mm inside a device body                                | 0 (max penetration 0.000 mm) |
| Samples sharing a 2 mm cell with another wire (wire–wire interpenetration) | **12 660 of 14 176 (89 %)**  |

Three **direct** routes, with no waypoints and no auto-route (TB1-3T to K2-2, TB1-12B to K4-5, K1-2 to K5-1): **2 of 3 went through device bodies**, 13 of 60 samples were more than 1 mm inside, and the deepest point was **20 mm** inside.

- **The plate and duct constraints work.** z ≥ r on the plate and box clamps in ducts kept every duct route in place, and the centripetal Catmull-Rom tube didn't overshoot behind the plate.
- **Wires pile into each other in ducts.** With no wire–wire collision, every wire in a horizontal duct sags onto the same line along the duct's lower wall. At N = 200 it reads as a few thick wires. Rope-to-rope collision would fix it at O(n²) per step, on top of the live-rope cost above.
- **Ropes don't collide with devices.** A direct route straight-lines through terminal blocks and contactors. The spike only avoids that through ducts and waypoints.
- **Duct walls aren't colliders.** The span from a clamp's lead-out to the duct centreline passes through the duct's side wall. A real duct has finger slots there, so it looks plausible, but the slots aren't modelled.
- **The live preview pops.** The span under the cursor is re-subdivided when its length changes by more than 30 %, and restarts straight, so the sag visibly jumps while you move the mouse.
- **Occlusion:** screen-space terminal picking ignores occlusion. That's right for a screw behind a freshly baked wire, but wrong for a terminal hidden behind a device seen from an angle. Seen face-on, lead-outs leave along ±y and don't cover screws, but a direct route drawn across a terminal row covers screws visually while they stay pickable.
- **Gotcha (three r186):** after `addUpdateRange()` on the `instanceMatrix` of a large `InstancedMesh` (here 102 400 instances, above the uniform-buffer limit, so three uses its interleaved instanced-attribute path), every later frame cost 40 to 250 ms of CPU on **both** backends, growing with the instance count. A plain `needsUpdate = true` (full upload) had no steady-state cost. The cause wasn't investigated further. Don't use partial update ranges on instanced attributes without re-measuring.

### Disposal

`clear()` returned the renderer's geometry count to baseline: 15 before, 65 with 50 `mesh` wires, 15 after. By its code, disposing the viewport also removes the spike's group, listeners and DOM panel; that path wasn't measured.

## Decisions (recommendations for P3)

### Interaction model

1. **The spool is the active tool-belt slot.** It stays selected across wires, so picking it costs one click per batch, not per wire.
2. **Two clicks per connection by default: source, then destination, with auto-route through ducts** at every difficulty. Waypoints stay optional: clicking a duct or a point on the plate forces the path through it, Backspace undoes the last waypoint and Esc cancels. Show the route preview live from the first click.
3. **Make terminals big enough before asking for a click.** At the default framing a terminal-block pitch is 4 to 6 px, against a 24 px minimum. When the pointer is over a terminal group whose pitch is below 24 px, offer a one-key zoom to that device (`view.focus` on the device) or a magnifier, rather than letting the player guess. Always highlight the terminal that a click would pick.
4. **Keyboard path:** with a device focused, Tab and Shift+Tab cycle its terminals and Enter picks one (DoD: keyboard-accessible). It reuses the selection-cycling input actions.
5. **Termination at Realistic:** six separate prompts make a connection 8 clicks instead of 2. That's fine for a few wires and a chore for fifty. P3 should fold strip and ferrule into one tool action per end and keep torque as a separate tool (which can fail), or let one prompt cover both ends. Keep Trainee automatic.

### Instancing for baked wires

**Bake into one `InstancedMesh` of short cylinder segments per conductor look**, with a colour per instance and a pooled capacity that doubles when full. Per wire it costs about 70 instances (64 B of matrix and 12 B of colour each, about 5.4 KB). A bake is 40 to 60 times cheaper than building a `TubeGeometry`, and draw calls don't grow with the number of wires. On the real GPU all three strategies stayed within noise of each other at 200 wires, and `mesh` was the only one whose frame time crept up (+0.6 ms on WebGPU, +1.9 ms on WebGL2). The rendering caveats already record that per-draw cost dominates on weak and software WebGPU, so wire counts must not drive draw counts.

- `BatchedMesh` is the fallback if close-ups show faceted joints: smooth tubes in one draw. It costs as much to bake as `mesh`, and its vertex and index capacity has to be sized up front.
- Live ropes use the same segment instancing, and there are only ever a few of them (the rope being routed and any still settling).

### Picking

- **Terminals:** treat them as data points on the device recipe (screw position, entry point, exit direction), not as meshes to raycast. A 3 px screw is no target. Pick in screen space: nearest within `min(16 px, pitch / 2)`, filtered by occlusion with the existing BVH picker (the ray's first hit must be the terminal's own device, within a tolerance). Show hover feedback.
- **Wires:** brute-force screen-space distance cost 1 to 2 ms at 200 wires (one sample each, after warm-up), which is too much for every hover frame at plant scale. Use a BVH over the segment bounds (the caveats' "picking goes through BVH" rule), with an exact ray-to-capsule test whose radius is widened to a minimum of about 4 px on screen.

### Live versus baked

Only the rope being routed, and ropes that are settling, simulate. Each live rope costs 50 to 85 µs of main-thread time per frame at 15 mm spacing (10.2 ms and 16.8 ms for 200 ropes in the two real-GPU runs). Everything else is static instances.

## What P3 must build

1. **Commands** `wire.add` and `wire.delete`, plus editing a wire later. Arguments: spool ref, source and destination terminal refs, waypoints in integer mm (with their duct ids), and the termination results. `save-format-guardian` reviews the argument shape, which the replay log persists.
2. **Route maths in a GPU-free domain module**, like `snap/`: the auto-duct path, waypoint snapping to ducts, and path length (F3.2 derives resistance from it). Scripts and `sim-cli` must route exactly as the mouse does.
3. **A deterministic bake.** The baked centreline must be a pure function of the command arguments: start the rope straight from the pins, choose the particle count from the integer path length, run a fixed number of steps, and quantise the result. Never bake from the live preview. Use `Math.sqrt`, never `Math.hypot` (whose rounding the spec doesn't pin). Test that `sim-cli` and the browser produce the same centreline hash.
4. **Terminal data on device recipes:** screw point, clamp entry point, exit direction, how many conductors a terminal takes, and the conductor size range (sourced, and reviewed by `electrical-realism-reviewer`).
5. **A duct model:** an interior box, lanes so that baked wires pack side by side (computed once at bake, not by collision), finger-slot entry points, and a fill figure for later inspector rules (sourced, never NEC text).
6. **An instanced-segment wire renderer** with a pooled capacity, registered with the `Disposer`, plus a disposal test (geometry count back to baseline). One live-preview rope.
7. **The terminal picker and the wire BVH picker** described above. Hover highlight, a zoom or magnifier affordance, and keyboard terminal cycling.
8. **The termination UI for each difficulty**, plus wire labels and numbers (plan §4.9, not prototyped).
9. **Waypoint and direct-route collision:** either refuse a route that passes through a device body (checked against device bounds in the route maths), or route around it.

## What P3 must avoid

- One `Mesh` plus `TubeGeometry` per wire. Draw calls and bake cost both grow with the wire count.
- Baked shapes that depend on the live preview, the mouse path or the frame rate. The spike's settled shape depended on where the cursor had been, so replay would not reproduce it.
- Physics for every wire on every frame. Settle once, bake, stop.
- Rope-to-rope collision as the fix for duct overlap. Pack lanes deterministically instead.
- Partial `addUpdateRange` uploads on large instanced attributes on three r186 (see the gotcha above).
- Requiring precise clicks at the default framing, or raycasting tiny terminal meshes.
- Storing particles in the save. Store the route arguments and re-bake.
- `Math.hypot`, `Math.random` or frame time anywhere in routing or bake maths (the determinism lint covers domain code; keep the maths there).

## Not prototyped

Conduit (EMT-lite), staples, cables with several conductors and stripping NM jacket, wire labels and numbers, routing in walk mode or between boxes (field wiring), editing or deleting a baked wire, and undo. These are all F3.2 or later.

## Manual protocol (seconds per connection)

The scripted times above are a floor. These steps measure a person.

1. Run `git switch spike/wire-routing && pnpm install`, then `pnpm start:web`, or `pnpm nx serve game --port 4320` if port 4200 is busy.
2. Open `http://localhost:4200/?spike=wire&e2e=1&hud` (use your port). Run it once more with `&renderer=webgl2` to see the fallback. Start a New sandbox (any seed). The spike panel is at the top right and names the backend.
3. Warm up: wire two connections of your choice.
4. **Task A (Trainee, auto-route):** tick _Auto-route via ducts_, pick a spool, press **Start drill**, and connect each green marker to its blue marker (10 pairs). Zoom with the wheel as much as you like. When the drill ends, the panel shows the mean seconds per pair (from the moment the pair appeared to the last click), the mean clicks, and the number of wrong connections.
5. **Task B (Trainee, manual):** untick _Auto-route_, press **Start drill** again, and route each pair through the duct between the rails: click the duct near the source and near the destination.
6. **Task C (Realistic, auto-route):** tick both boxes, press **Start drill**, and do the six termination prompts for each pair.
7. Optionally, repeat Task A without zooming, to feel the default-framing hit-target problem.
8. Record the panel's numbers, or run `copy(JSON.stringify(__wireSpike.connections))` in DevTools, which gives every connection's clicks, missed clicks, `tShown`, `t0` and `t1`. Note the zoom you settled on and any wrong picks, then add the results to this ADR as an amendment.

## Consequences

- F3.2 starts from a measured design: two-click auto-routed connections, instanced segments, screen-space terminal picking with occlusion filtering, and a deterministic bake from command arguments.
- The open risk is now human speed and accuracy, which the manual protocol measures, and the 2020-era iGPU budget, which still needs a real integrated GPU. The P3 frame-time probe (plan §8 "Performance") should include a 500-device plant with its wires.
- The spike branch stays unmerged. Nothing from it, and no dependency, reaches `main`; only this ADR does.

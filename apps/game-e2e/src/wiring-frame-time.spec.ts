import { expect, type Page, test } from '@playwright/test';
import { startSandbox } from './support/sandbox';

/**
 * P3's frame-time measurement with a wired plant (plans/phase-3-wiring.md, "Budgets"): a **manual
 * tool**, not a check, like overlay-frame-time.spec.ts. It is skipped unless
 * `CONTROLS_MEASURE_WIRING=1`, prints its numbers and asserts nothing about them (headless frame
 * times are not a GPU figure: rendering caveats). The SwiftShader figure is recorded, not gated; the
 * user records a real GPU (manual, as in P2), including a 2020-era integrated GPU if one is available.
 * Recorded results: docs/architecture/rendering.md "The wire renderer (F3.2 part 2)".
 *
 * The plant is `sim bench`'s `route-bake-500-wires` panel (apps/sim-cli/src/bench/route-bake.ts) in
 * front of the workshop backplate: ten rows of fifty 4 mm² screw blocks under eleven 40 × 60 ducts and
 * a riser (512 devices), and 500 THHN conductors from block i's top clamp to block (7i + 13) mod 500's
 * bottom clamp, each `--route auto --lengthMm auto` and landed at the marked 0.6 N·m (the workshop is
 * Apprentice, so no `'auto'` terminations). It runs as one console file through `run`, so the router
 * and the console's expanders run in Chromium. Each size measures 120 frames with the wires drawn
 * (frames forced back to back with `afterFrames`), then 240 with the voltage and current overlays on
 * (D15: the wire instances recoloured; nothing is solved here, so every conductor draws "unknown").
 * `CONTROLS_MEASURE_RENDERER=webgpu` drops `?renderer=webgl2`; run headed (`--headed`) on a desktop to
 * measure the real GPU. Then 240 frames with the heat overlay alone (F3.6 part 3): the conductors read
 * their records' temperatures (ambient, a reading: the bank holds every wire, netlisted or not), so
 * every instance is recoloured from the heat ramp.
 */
const enabled = process.env['CONTROLS_MEASURE_WIRING'] === '1';
const backend = process.env['CONTROLS_MEASURE_RENDERER'] === 'webgpu' ? '' : '&renderer=webgl2';

const ROWS = 10;
const BLOCKS = 50;
const ROW_PITCH = 150;
const DUCT_LENGTH = 320;
/** The panel's origin: in front of the backplate (its face is z = 0, its lower-left corner −300, −400). */
const OX = -290;
const OY = -800;
const OZ = 40;

const DUCT = '--ref.id duct.lattisby-40x60 --ref.version 1';
const BLOCK = '--ref.id tb.quennick-st4 --ref.version 1';
const WIRE = '--ref.id conductor.tallowmere-thhn-14-solid --ref.version 1';
const TAIL = '--colour.base black --colour.stripe null --tool.id tool.veltmark-dc-8 --tool.version 1';
const xyz = (x: number, y: number, z: number) =>
  `--positionMm.x ${OX + x} --positionMm.y ${OY + y} --positionMm.z ${OZ + z}`;
/** A landed end at the block's marked 0.6 N·m, stripped 9 mm in the 14 AWG solid hole. */
const end = (side: 'a' | 'b', entity: number, terminal: string) =>
  [
    `--${side}.entity ${entity} --${side}.terminal ${terminal} --${side}.termination.method screw`,
    `--${side}.termination.strip.tool.id tool.veltmark-ws-1018 --${side}.termination.strip.tool.version 1`,
    `--${side}.termination.strip.hole sol14 --${side}.termination.strip.lengthMm 9 --${side}.termination.accessory null`,
    `--${side}.termination.clamp.tool.id tool.calderyn-ts-03 --${side}.termination.clamp.tool.version 1`,
    `--${side}.termination.clamp.torqueNm 0.6`,
  ].join(' ');

/** The plant as one console file (the route-bake bench's panel, moved in front of the backplate). */
function plantScript(): { text: string; commands: number } {
  const lines: string[] = [];
  for (let r = 0; r <= ROWS; r++) {
    lines.push(`entity.place ${DUCT} ${xyz(0, ROW_PITCH * r, 0)}`, `raceway.cut ${r + 1} --lengthMm ${DUCT_LENGTH}`);
  }
  lines.push(
    `entity.place ${DUCT} ${xyz(DUCT_LENGTH + 40, 0, 0)} --orientationMdeg.yaw 0 --orientationMdeg.pitch 0 --orientationMdeg.roll 90000`,
    `raceway.cut ${ROWS + 2} --lengthMm ${ROW_PITCH * ROWS + 40}`,
  );
  const first = ROWS + 3;
  for (let r = 0; r < ROWS; r++) {
    for (let k = 0; k < BLOCKS; k++) lines.push(`entity.place ${BLOCK} ${xyz(10 + 6 * k, ROW_PITCH * r + 60, 0)}`);
  }
  const n = ROWS * BLOCKS;
  for (let i = 0; i < n; i++) {
    const a = end('a', first + i, 'a');
    const b = end('b', first + ((7 * i + 13) % n), 'b');
    lines.push(`wire.add ${WIRE} ${a} ${b} --route auto --lengthMm auto ${TAIL}`);
  }
  return { text: lines.join('\n'), commands: lines.length };
}

type Stats = Record<string, number | boolean>;
type Hooks = {
  __controlsViewport?: {
    stats(): Stats;
    afterFrames(n: number): Promise<void>;
    setOverlay(name: 'voltage' | 'current' | 'heat', on: boolean): void;
    wireGraph(): { routes: unknown[]; looks: { look: string; instances: number }[] } | undefined;
    overlayGraph(): { conductors: { heat: (number | 'unknown')[] }[] } | undefined;
    focus(id: string): boolean;
  };
};

/** `frames` frames drawn back to back: the HUD's cost figures plus the wall time per frame. */
const measure = (page: Page, frames: number) =>
  page.evaluate(async (n) => {
    const viewport = (window as unknown as Hooks).__controlsViewport;
    if (!viewport) throw new Error('viewport hook missing');
    viewport.stats(); // a new window
    const start = performance.now();
    await viewport.afterFrames(n);
    const wall = (performance.now() - start) / n;
    const s = viewport.stats();
    return { avgMs: s['avgMs'], worstMs: s['worstMs'], drawCalls: s['drawCalls'], wallMsPerFrame: wall };
  }, frames);

test.skip(!enabled, 'manual measurement: set CONTROLS_MEASURE_WIRING=1');

for (const size of [
  { width: 1280, height: 720 },
  { width: 1920, height: 1080 },
]) {
  test(`frame time with 512 devices and 500 wires, ${size.width}×${size.height}`, async ({ page }) => {
    test.setTimeout(1_800_000);
    await page.setViewportSize(size);
    await page.goto(`/?e2e=1&hud${backend}`);
    await startSandbox(page);
    await expect(page.locator('ctl-viewport')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
    await expect(page.locator('ctl-dev-console [data-editor="ready"]')).toBeAttached();
    await page.keyboard.press('Backquote');
    await expect(page.getByRole('textbox', { name: 'Console input' })).toBeFocused();
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.type('run');
    await page.keyboard.press('Enter');
    const plant = plantScript();
    await (
      await chooser
    ).setFiles({ name: 'wired-plant.console', mimeType: 'text/plain', buffer: Buffer.from(plant.text) });
    await expect(page.getByTestId('console-output').locator('.entry').last()).toHaveText(
      `Ran ${plant.commands} commands from wired-plant.console.`,
      { timeout: 1_200_000 },
    );
    await page.evaluate(() => (window as unknown as Hooks).__controlsViewport?.focus('backplate'));
    await expect
      .poll(() => page.evaluate(() => (window as unknown as Hooks).__controlsViewport?.wireGraph()?.routes.length))
      .toBe(500);
    const looks = await page.evaluate(() => (window as unknown as Hooks).__controlsViewport?.wireGraph()?.looks);
    await measure(page, 30); // warm-up
    const drawn = await measure(page, 120);
    await page.evaluate(() => {
      const viewport = (window as unknown as Hooks).__controlsViewport;
      viewport?.setOverlay('voltage', true);
      viewport?.setOverlay('current', true);
    });
    await measure(page, 30); // warm-up: overlay shaders compile
    const overlays = await measure(page, 240);
    await page.evaluate(() => {
      const viewport = (window as unknown as Hooks).__controlsViewport;
      viewport?.setOverlay('voltage', false);
      viewport?.setOverlay('current', false);
      viewport?.setOverlay('heat', true);
    });
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as unknown as Hooks).__controlsViewport
            ?.overlayGraph()
            ?.conductors.every((c) => c.heat.every((h) => h !== 'unknown')),
        ),
      )
      .toBe(true);
    await measure(page, 30); // warm-up
    const heat = await measure(page, 240);
    console.log(
      JSON.stringify({
        size,
        devices: 512,
        wires: 500,
        looks,
        backend: backend ? 'webgl2' : 'auto',
        drawn,
        overlays,
        heat,
      }),
    );
  });
}

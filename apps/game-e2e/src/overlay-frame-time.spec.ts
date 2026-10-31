import { expect, type Page, test } from '@playwright/test';
import { startSandbox } from './support/sandbox';

/**
 * F2.6's frame-time measurement with both debug overlays on: a **manual tool**, not a check. It is
 * skipped unless `CONTROLS_MEASURE_OVERLAYS=1`, prints its numbers and asserts nothing about them
 * (headless frame times are not a GPU figure: rendering caveats). Procedure and recorded results:
 * docs/architecture/rendering.md "Debug overlays (F2.6)".
 *
 * The plant: `CONTROLS_MEASURE_PAIRS` (default 250) battery-and-switch pairs on the bench, each
 * switch closed across its battery through two test leads (500 devices and 500 leads at the
 * default), built in batches so the sim worker keeps up, with the sim running at 1×. Each size
 * measures 120 frames with the overlays off, then 240 with voltage and current on (the arrows
 * animate, so every frame is drawn back to back). `CONTROLS_MEASURE_RENDERER=webgpu` drops
 * `?renderer=webgl2`; run headed (`--headed`) on a desktop to measure the real GPU.
 */
const enabled = process.env['CONTROLS_MEASURE_OVERLAYS'] === '1';
const pairs = Number(process.env['CONTROLS_MEASURE_PAIRS'] ?? 250);
const backend = process.env['CONTROLS_MEASURE_RENDERER'] === 'webgpu' ? '' : '&renderer=webgl2';

type Stats = Record<string, number | boolean>;
type Hooks = {
  __controlsSession?: { exec(id: string, args?: unknown): { ok: boolean }; simStatus(): string };
  __controlsViewport?: {
    stats(): Stats;
    afterFrames(n: number): Promise<void>;
    overlayGraph(): { leads: { amps: number | 'unknown' }[] } | undefined;
    setOverlay(name: 'voltage' | 'current', on: boolean): void;
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
    return { avgMs: s['avgMs'], worstMs: s['worstMs'], fps: s['fps'], drawCalls: s['drawCalls'], wallMsPerFrame: wall };
  }, frames);

const status = (page: Page) => page.evaluate(() => (window as unknown as Hooks).__controlsSession?.simStatus());

test.skip(!enabled, 'manual measurement: set CONTROLS_MEASURE_OVERLAYS=1');

for (const size of [
  { width: 1280, height: 720 },
  { width: 1920, height: 1080 },
]) {
  test(`frame time with both overlays on, ${2 * pairs} devices and leads, ${size.width}×${size.height}`, async ({
    page,
  }) => {
    test.setTimeout(1_800_000);
    await page.setViewportSize(size);
    await page.goto(`/?e2e=1&hud${backend}`);
    await startSandbox(page);
    await expect(page.locator('ctl-viewport')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
    const batch = 10;
    for (let first = 0; first < pairs; first += batch) {
      const failures = await page.evaluate(
        ({ first, count }) => {
          const session = (window as unknown as Hooks).__controlsSession;
          if (!session) throw new Error('session hook missing');
          const lead = { id: 'lead.quillfern-test-1m', version: 1 };
          const orientationMdeg = { yaw: 0, pitch: 0, roll: 0 };
          let failed = 0;
          for (let i = first; i < first + count; i++) {
            const x = 750 + (i % 25) * 70;
            const z = 100 + Math.floor(i / 25) * 70;
            const [battery, sw] = [1 + 2 * i, 2 + 2 * i];
            const results = [
              session.exec('entity.place', {
                ref: { id: 'battery.ferrovane-12v-7ah', version: 1 },
                positionMm: { x, y: -1100, z },
                orientationMdeg,
              }),
              session.exec('entity.place', {
                ref: { id: 'switch.tessaline-spst-toggle', version: 1 },
                positionMm: { x, y: -1000, z },
                orientationMdeg,
              }),
              session.exec('lead.connect', {
                ref: lead,
                a: { entity: battery, terminal: 'pos' },
                b: { entity: sw, terminal: 'a' },
              }),
              session.exec('lead.connect', {
                ref: lead,
                a: { entity: sw, terminal: 'b' },
                b: { entity: battery, terminal: 'neg' },
              }),
              session.exec('device.operate', { id: sw, control: 'closed', value: true }),
            ];
            failed += results.filter((r) => !r.ok).length;
          }
          return failed;
        },
        { first, count: Math.min(batch, pairs - first) },
      );
      expect(failures).toBe(0);
      // Let the worker take the batch in before the next one (a burst of thousands of commands is a
      // different measurement).
      await page.evaluate(() => (window as unknown as Hooks).__controlsViewport?.afterFrames(2));
      expect(await status(page)).not.toBe('crashed');
    }
    await page.evaluate(() => {
      (window as unknown as Hooks).__controlsSession?.exec('sim.setSpeed', { speed: 1 });
      (window as unknown as Hooks).__controlsViewport?.focus('bench');
    });
    await expect.poll(() => status(page), { timeout: 120_000 }).toBe('running');
    await measure(page, 30); // warm-up
    const off = await measure(page, 120);
    await page.evaluate(() => {
      const viewport = (window as unknown as Hooks).__controlsViewport;
      viewport?.setOverlay('voltage', true);
      viewport?.setOverlay('current', true);
    });
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as unknown as Hooks).__controlsViewport
                ?.overlayGraph()
                ?.leads.filter((l) => l.amps !== 'unknown' && l.amps > 0).length,
          ),
        { timeout: 300_000 },
      )
      .toBe(2 * pairs);
    await measure(page, 30); // warm-up: overlay shaders compile
    const on = await measure(page, 240);
    console.log(
      JSON.stringify({ size, devices: 2 * pairs, leads: 2 * pairs, backend: backend ? 'webgl2' : 'auto', off, on }),
    );
  });
}

import { expect, test } from '@playwright/test';
import { startSandbox } from './support/sandbox';

/**
 * P3's frame-time measurement with a wired plant (plans/phase-3-wiring.md, "Budgets"): a **manual
 * tool**, not a check, like overlay-frame-time.spec.ts. It is skipped unless
 * `CONTROLS_MEASURE_WIRING=1`, will print its numbers and assert nothing about them (headless frame
 * times are not a GPU figure: rendering caveats). The SwiftShader figure is recorded, not gated; the
 * user records a real GPU (manual, as in P2), including a 2020-era integrated GPU if one is available.
 *
 * Scaffold only (P3 kickoff step 6). TODO(F3.2 part 2, F3.6 part 3): build a 500-device plant with
 * its routed wires through `wire.add` (world v3 commands) in batches, as overlay-frame-time.spec.ts
 * does with leads; measure frames with the wires drawn (F3.2's instanced segments) and with the
 * thermal readouts on (F3.6 part 3), at 1280×720 and 1920×1080; `CONTROLS_MEASURE_RENDERER=webgpu`
 * drops `?renderer=webgl2`. Until then, enabling it fails rather than reporting a number it didn't
 * measure.
 */
const enabled = process.env['CONTROLS_MEASURE_WIRING'] === '1';
const backend = process.env['CONTROLS_MEASURE_RENDERER'] === 'webgpu' ? '' : '&renderer=webgl2';

test.skip(!enabled, 'manual measurement: set CONTROLS_MEASURE_WIRING=1');

test('frame time with 500 devices and their wires', async ({ page }) => {
  await page.goto(`/?e2e=1&hud${backend}`);
  await startSandbox(page);
  await expect(page.locator('ctl-viewport')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  throw new Error('not implemented: the wired plant needs wire.add and the wire renderer (F3.2 part 2, F3.6 part 3)');
});

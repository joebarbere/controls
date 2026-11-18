import { expect, test } from '@playwright/test';
import { startSandbox } from './support/sandbox';

/**
 * P4's frame-time measurement with the wired acceptance house (plans/phase-4-residential.md,
 * "Budgets"): a **manual tool**, not a check, like wiring-frame-time.spec.ts. It is skipped unless
 * `CONTROLS_MEASURE_HOUSE=1`, will print its numbers and assert nothing about them (headless frame
 * times are not a GPU figure: rendering caveats). The SwiftShader figure is recorded, not gated; the
 * user records a real GPU (manual, as in P2 and P3).
 *
 * Scaffold only (P4 kickoff step 4). TODO(F4.6 part 2): start the sandbox on the house map
 * (`content/levels/house.json`, the New sandbox map chooser), wire every circuit through a console
 * file run as wiring-frame-time.spec.ts runs its plant, and measure frames in walk mode from two rooms
 * and from the panel, with the overlays off and with voltage, current and heat on, at 1280×720 and
 * 1920×1080; `CONTROLS_MEASURE_RENDERER=webgpu` drops `?renderer=webgl2`. Record the results in
 * docs/architecture/rendering.md. Until then, enabling it fails rather than reporting a number it
 * didn't measure.
 */
const enabled = process.env['CONTROLS_MEASURE_HOUSE'] === '1';
const backend = process.env['CONTROLS_MEASURE_RENDERER'] === 'webgpu' ? '' : '&renderer=webgl2';

test.skip(!enabled, 'manual measurement: set CONTROLS_MEASURE_HOUSE=1');

test('frame time in the wired house', async ({ page }) => {
  await page.goto(`/?e2e=1&hud${backend}`);
  await startSandbox(page);
  await expect(page.locator('ctl-viewport')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  throw new Error('not implemented: the house needs content/levels/house.json and the map chooser (F4.6 part 2)');
});

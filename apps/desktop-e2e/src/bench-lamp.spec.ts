import { expect, test } from '@playwright/test';
import { BENCH_LAMP_HASH, BENCH_LAMP_LIT_HASH, benchLampScenario, hashAfter, newSandbox } from './game';
import { launchControls } from './launch';

/**
 * F2.5, decision D6 in the shipped runtime: the bench demo's console lines typed into the desktop app
 * (Electron 45's V8, not Playwright's Chromium) reach the same world hashes `apps/sim-cli/src/
 * bench-lamp.spec.ts` pins under Node, lit and then out (the literals live in `./game.ts`).
 */
test('the bench demo reaches the sim-cli hashes in Electron (D6, F2.5)', async () => {
  test.slow(); // a cold Electron start on CI runners
  const app = await launchControls();
  try {
    const { window } = app;
    await newSandbox(window, 0);
    const { lit, out } = benchLampScenario();
    expect(await hashAfter(window, ...lit)).toBe(BENCH_LAMP_LIT_HASH);
    expect(await hashAfter(window, ...out)).toBe(BENCH_LAMP_HASH);
  } finally {
    await app.close();
  }
});

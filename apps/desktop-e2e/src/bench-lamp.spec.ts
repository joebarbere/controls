import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashAfter, newSandbox } from './game';
import { launchControls } from './launch';

/**
 * F2.5, decision D6 in the shipped runtime: the bench demo's console lines typed into the desktop app
 * (Electron 45's V8, not Playwright's Chromium) reach the same world hashes `apps/sim-cli/src/
 * bench-lamp.spec.ts` pins under Node, lit and then out. Change all of them together, never one: a
 * difference here is float drift between V8 builds, not a golden to re-pin.
 */
const BENCH_LAMP_LIT_HASH = 'ed42d957348f2c2f79aad6ed892228a20e59bb543ba3e348399595c37d7b3fbc';
const BENCH_LAMP_HASH = '0b533c942486866c3d8757b94dfdb6c2d891f66ae0401f97a96aac4d1ea6cb28';

test('the bench demo reaches the sim-cli hashes in Electron (D6, F2.5)', async () => {
  test.slow(); // a cold Electron start on CI runners
  const app = await launchControls();
  try {
    const { window } = app;
    await newSandbox(window, 0);
    const lines = readFileSync(join(__dirname, '../../sim-cli/scenarios/bench-lamp.console'), 'utf8')
      .split('\n')
      .map((line) => line.replace(/#.*$/, '').trim())
      .filter(Boolean);
    const lit = lines.indexOf('world.hash');
    expect(lit).toBe(8);
    expect(await hashAfter(window, ...lines.slice(0, lit))).toBe(BENCH_LAMP_LIT_HASH);
    expect(await hashAfter(window, ...lines.slice(lit + 1, lines.lastIndexOf('world.hash')))).toBe(BENCH_LAMP_HASH);
  } finally {
    await app.close();
  }
});

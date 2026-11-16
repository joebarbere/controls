import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashAfter, newSandbox } from './game';
import { launchControls } from './launch';

/**
 * The P3 phase acceptance in the shipped runtime: `apps/sim-cli/scenarios/lamp-circuit.console` typed
 * into the desktop app's console (Electron 45's V8, not Playwright's Chromium) on a Journeyman seed-0
 * sandbox reaches the world hashes `apps/sim-cli/src/lamp-circuit.spec.ts` pins under Node, lit and
 * then out. The literals live in `apps/sim-cli/scenarios/acceptance-hashes.json` (read with `fs`);
 * re-pin them there, never here. The browser half, with the UI-built cable run, is
 * `apps/game-e2e/src/wiring-acceptance.spec.ts`.
 */
const SCENARIOS = join(__dirname, '../../sim-cli/scenarios');
const HASHES = JSON.parse(readFileSync(join(SCENARIOS, 'acceptance-hashes.json'), 'utf8')) as {
  lampCircuit: { litHash: string; hash: string };
};

test('the lamp circuit reaches the sim-cli hashes in Electron (P3 acceptance)', async () => {
  test.slow(); // a cold Electron start on CI runners, then about 40 console lines
  const lines = readFileSync(join(SCENARIOS, 'lamp-circuit.console'), 'utf8')
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean);
  const lit = lines.indexOf('world.hash');
  const out = lines.lastIndexOf('world.hash');
  expect([lit, out, lines.length]).toStrictEqual([40, 43, 44]);
  const app = await launchControls();
  try {
    const { window } = app;
    // The scenario is built at Journeyman (`sim run … --difficulty journeyman`): the world records it.
    await window.getByRole('navigation', { name: 'Controls' }).getByRole('button', { name: 'Settings' }).click();
    const settings = window.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('combobox', { name: 'Default for new games' }).selectOption('journeyman');
    await window.keyboard.press('Escape');
    await expect(settings).toBeHidden();
    await newSandbox(window, 0);
    expect(await hashAfter(window, ...lines.slice(0, lit))).toBe(HASHES.lampCircuit.litHash);
    expect(await hashAfter(window, ...lines.slice(lit + 1, out))).toBe(HASHES.lampCircuit.hash);
  } finally {
    await app.close();
  }
});

import { expect, type Page, test } from '@playwright/test';
import { startSandbox } from './support/sandbox';

/*
 * F2.3b: time control from keybindings, the palette and the console (ADR 0011 §13). Every surface
 * runs the same logged sim.* commands; the HUD shows the sim time from the worker's snapshots and
 * the requested speed as one radio group, and announces transitions in a polite live region.
 */

type Hooks = {
  __controlsSession?: {
    entries(): ReadonlyArray<{ id: string; args: Record<string, unknown>; tick: number }>;
    simTick(): number;
    simStatus(): string;
    simPacing(): boolean;
    waitForTick(tick: number): Promise<void>;
    busWorld(): { tick: number; entities: readonly unknown[] };
    exec(id: string, args?: unknown): { ok: boolean };
  };
};
const hook = <T>(page: Page, read: (h: NonNullable<Hooks['__controlsSession']>) => T) =>
  page.evaluate(
    ({ src }) => {
      const session = (window as unknown as Hooks).__controlsSession;
      if (!session) throw new Error('session hook missing');
      return new Function('h', `return (${src})(h)`)(session) as T;
    },
    { src: read.toString() },
  );
const logged = (page: Page) => hook(page, (h) => h.entries().map((e) => `${e.id} ${JSON.stringify(e.args)}`));

test('pause, speeds and steps from the keys, the palette and the console; the HUD follows', async ({ page }) => {
  await page.goto('/?e2e=1&renderer=webgl2');
  await startSandbox(page);
  await expect(page.locator('ctl-viewport')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  const canvas = page.locator('ctl-viewport canvas');
  await expect(canvas).toBeFocused();

  const hud = page.getByRole('region', { name: 'Sim time' });
  const speed = hud.getByRole('group', { name: 'Speed' });
  const announcement = hud.getByTestId('sim-announcement');
  await expect(hud.getByTestId('sim-time')).toHaveText('0:00:00.000');
  await expect(speed.getByRole('radio', { name: 'Pause' })).toBeChecked(); // a new game starts paused
  await expect(announcement).toHaveText('The simulation is paused.');

  // Keys: Period steps 10 ms exactly; Shift+2 runs at 10×; P pauses and resumes.
  await page.keyboard.press('Period');
  await hook(page, (h) => h.waitForTick(10));
  await expect(hud.getByTestId('sim-time')).toHaveText('0:00:00.010');
  await page.keyboard.press('Shift+Digit2');
  await expect(speed.getByRole('radio', { name: '10×' })).toBeChecked();
  await expect(hud.getByTestId('sim-effective')).toContainText('Running at');
  await expect.poll(() => hook(page, (h) => h.simTick())).toBeGreaterThan(100); // time passes on its own
  await page.keyboard.press('KeyP');
  await expect(speed.getByRole('radio', { name: 'Pause' })).toBeChecked();
  await expect(announcement).toHaveText('The simulation is paused.');
  const paused = await hook(page, (h) => h.busWorld().tick);
  await hook(page, (h) => h.waitForTick(h.busWorld().tick));
  await expect.poll(() => hook(page, (h) => h.simTick())).toBe(paused); // a paused sim shows its exact tick (panel rate)
  await page.keyboard.press('KeyP');
  await expect(speed.getByRole('radio', { name: '10×' })).toBeChecked(); // resume: the last speed
  await page.keyboard.press('Shift+Digit1');
  await expect(speed.getByRole('radio', { name: '1×' })).toBeChecked();
  await page.keyboard.press('KeyP');
  await expect(speed.getByRole('radio', { name: 'Pause' })).toBeChecked();

  // The palette: Step sim time with its default (1 s).
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await page.keyboard.press('Control+K');
  await expect(palette.getByRole('combobox', { name: 'Search commands' })).toBeFocused();
  await page.keyboard.type('Step sim time');
  await expect(palette.getByRole('option').first()).toHaveAttribute('data-command', 'sim.step');
  await page.keyboard.press('Enter');
  const form = palette.getByRole('form', { name: 'Arguments for Step sim time' });
  await expect(form.getByRole('textbox', { name: 'Sim time (ms)' })).toHaveValue('1000');
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
  const stepped = await hook(page, (h) => h.busWorld().tick);
  await hook(page, (h) => h.waitForTick(h.busWorld().tick));
  await expect.poll(() => hook(page, (h) => h.simTick())).toBe(stepped);

  // The console: sim.setSpeed 60, then sim.setSpeed 0, typed.
  await expect(page.locator('ctl-dev-console [data-editor="ready"]')).toBeAttached();
  await page.keyboard.press('Backquote');
  await expect(page.getByRole('textbox', { name: 'Console input' })).toBeFocused();
  await page.keyboard.type('sim.setSpeed 60');
  await page.keyboard.press('Enter');
  await expect(speed.getByRole('radio', { name: '60×' })).toBeChecked();
  await page.keyboard.type('sim.setSpeed 0');
  await page.keyboard.press('Enter');
  await expect(speed.getByRole('radio', { name: 'Pause' })).toBeChecked();

  // The radio group itself runs the same command.
  await speed.getByRole('radio', { name: '10×' }).check();
  await expect.poll(() => hook(page, (h) => h.simStatus())).toBe('running');

  expect(await logged(page)).toEqual([
    'sim.step {"ticks":10}',
    'sim.setSpeed {"speed":10}',
    'sim.setSpeed {"speed":0}',
    'sim.resume {}',
    'sim.setSpeed {"speed":1}',
    'sim.setSpeed {"speed":0}',
    'sim.step {"ticks":1000}',
    'sim.setSpeed {"speed":60}',
    'sim.setSpeed {"speed":0}',
    'sim.setSpeed {"speed":10}',
  ]);
});

test('a hidden window suspends the sim and a shown one resumes it (U1)', async ({ page }) => {
  await page.goto('/?e2e=1&renderer=webgl2');
  await startSandbox(page);
  const hud = page.getByRole('region', { name: 'Sim time' });
  await page.keyboard.press('Shift+Digit1');
  await expect.poll(() => hook(page, (h) => h.simStatus())).toBe('running');
  // Headless Chromium reports the page as visible (ADR 0011 "Deferred"), so fake the hidden state.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(hud).toHaveAttribute('data-status', 'suspended');
  await expect(hud.getByTestId('sim-announcement')).toHaveText(
    'The simulation is suspended while the window is hidden.',
  );
  expect(await hook(page, (h) => h.simPacing())).toBe(false); // no pacing loop at all while hidden
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(hud).toHaveAttribute('data-status', 'running');
  const shown = await hook(page, (h) => h.busWorld().tick);
  expect(await hook(page, (h) => h.simPacing())).toBe(true);
  await expect.poll(() => hook(page, (h) => h.busWorld().tick)).toBeGreaterThan(shown);
});

test('a burst of 1,250 commands while running never trips the watchdog (a busy worker is not a hung one)', async ({
  page,
}) => {
  await page.goto('/?e2e=1&renderer=webgl2');
  await startSandbox(page);
  await expect(page.locator('ctl-viewport')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  await page.locator('ctl-viewport canvas').focus();
  await page.keyboard.press('Shift+Digit2'); // 10×: the target runs ahead of the worker while it drains
  await expect.poll(() => hook(page, (h) => h.simStatus())).toBe('running');
  const placed = await hook(page, (h) => {
    let ok = 0;
    for (let i = 0; i < 1_250; i++)
      if (h.exec('entity.place', { ref: { id: 'prop.crate', version: 1 }, positionMm: { x: i, y: 0, z: -20 } }).ok)
        ok++;
    return ok;
  });
  expect(placed).toBe(1_250);
  const after = await hook(page, (h) => h.busWorld().tick);
  // Past a whole watchdog period of sim time at 10× (3 s of wall time): the worker kept up, never crashed.
  await expect.poll(() => hook(page, (h) => h.simTick()), { timeout: 30_000 }).toBeGreaterThan(after + 30_000);
  expect(await hook(page, (h) => h.simStatus())).toBe('running');
  await expect(page.getByRole('alert').filter({ hasText: 'The simulation stopped' })).toHaveCount(0);
  expect(await hook(page, (h) => h.busWorld().entities.length)).toBeGreaterThanOrEqual(1_250);
});

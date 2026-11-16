import { expect, type Page, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expectOnCanvas, terminalOnPage } from './support/aim';
import { runLogged } from './support/console';
import { tabTo } from './support/focus';
import { enterSeed, startSandbox } from './support/sandbox';

/**
 * The P3 phase acceptance in Chromium (plans/phase-3-wiring.md, "Phase acceptance"): the lamp circuit,
 * built at Journeyman on the seed-0 workshop, reaches the world and snapshot hashes
 * `apps/sim-cli/src/lamp-circuit.spec.ts` pins under Node (`acceptance-hashes.json`, read here with
 * `fs`), through the sim worker on both transports (the shared buffer and the `?sab=0` postMessage
 * fallback). `apps/sim-cli/scenarios/lamp-circuit.console` is the script; every world command the
 * game logs must be exactly one of its lines, in its order, whichever surface made it:
 *
 * - **Mouse and keyboard** (both transports): cable 2 (the junction box's bottom clamp, a staple on
 *   stud 4, a bore through stud 5 with the default 3/4 in ship auger, a staple on stud 6, the lamp
 *   box's bottom clamp) is played with the cable gesture; its jacket is stripped in the strip prompt
 *   (reopened with Shift+N and J, so cable 1's strips, typed into the console, come first as in the
 *   script); its five conductor ends are landed with the landing flow's termination prompts: three
 *   twist-on wire nuts and the lamp's two screws, with the NM stripper and the 1-5 N·m torque
 *   screwdriver chosen in the prompts. The lamp's screws are clicked; the nuts are picked with `]`,
 *   Tab and Enter, because the renderer has no recipe for a wire nut yet and draws the 100 mm
 *   placeholder cube, which hides the splice terminal from the mouse (docs/caveats/ui.md). Waypoints are aimed at world points the snapper resolves to the
 *   script's (cursors are rounded to whole mm, so a click projected from the exact point lands on it).
 *   Every other line is typed into the console, interleaved where the script interleaves.
 * - **Keyboard only** (no pointer event at all, counted from the first document script): the panel's
 *   THHN jumper (wire 1), routed with `]` to the breaker, Tab / Shift+Tab through its terminals, Enter,
 *   the termination prompts, then the line block, whose auto-route is the script's straight line.
 * - **Replay**: `bad-termination.console` through the console's `run` reaches `BAD_TERMINATION_*`
 *   (both transports).
 *
 * The baked centreline's Node/Chromium parity is `routing-parity.spec.ts` (not repeated here).
 * Re-pin hashes in `acceptance-hashes.json` (and the sim-cli specs), never here.
 */

const SCENARIOS = join(__dirname, '../../sim-cli/scenarios');
const HASHES = JSON.parse(readFileSync(join(SCENARIOS, 'acceptance-hashes.json'), 'utf8')) as {
  lampCircuit: { litHash: string; litSnapshotHash: string; hash: string; snapshotHash: string };
  badTermination: { hash: string; snapshotHash: string };
};
/** The lamp circuit's lines, comments stripped (the `world.hash` lines included). */
const SCRIPT = readFileSync(join(SCENARIOS, 'lamp-circuit.console'), 'utf8')
  .split('\n')
  .map((line) => line.replace(/#.*$/, '').trim())
  .filter(Boolean);

const NMB = 'cable.sorrelby-nmb-14-2';
const THHN = 'conductor.tallowmere-thhn-14-solid';
const NM_STRIPPER = 'tool.veltmark-ws-nm12@1';
const BIG_DRIVER = 'tool.calderyn-ts-15@1';

type Vec = { x: number; y: number; z: number };
type Entry = { id: string; tick: number; args: Record<string, unknown> };
type Hooks = {
  __controlsViewport?: {
    whenIdle(): Promise<void>;
    projectMm(p: Vec): { x: number; y: number } | undefined;
    state: { selectedWire: { kind: string; id: number } | null };
  };
  __controlsSession?: {
    entries(): readonly Entry[];
    snapshotHash(): Promise<string>;
    waitForTick(tick: number): Promise<void>;
    simStats(): { misses: number; transport: string | null };
  };
};

const entries = (page: Page): Promise<Entry[]> =>
  page.evaluate(() => ((window as unknown as Hooks).__controlsSession?.entries() ?? []).map((e) => ({ ...e })));
const snapshotHash = (page: Page): Promise<string> =>
  page.evaluate(() => (window as unknown as Hooks).__controlsSession?.snapshotHash() ?? '');

/** Sorts object keys at every depth (the console files list arguments in key order). */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((k) => [k, sorted((value as Record<string, unknown>)[k])]),
  );
}

/** A logged entry as a `.console` line: dotted flags in key order, lists as JSON words. */
function scriptLine(entry: Pick<Entry, 'id' | 'args'>): string {
  const words: string[] = [];
  const walk = (prefix: string, value: unknown) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const k of Object.keys(value).sort()) walk(`${prefix}${k}.`, (value as Record<string, unknown>)[k]);
      return;
    }
    const word = Array.isArray(value) ? JSON.stringify(sorted(value)) : String(value);
    words.push(`--${prefix.slice(0, -1)} ${word}`);
  };
  walk('', entry.args);
  return [entry.id, ...words].join(' ');
}

/** The world commands logged so far as script lines (view and tool-belt commands left out). */
const worldLines = async (page: Page): Promise<string[]> =>
  (await entries(page)).filter((e) => !/^(view|toolbelt)\./.test(e.id)).map(scriptLine);

/** Script lines `from` to `to` (exclusive), each run in the open console and checked as logged. */
async function typeScript(page: Page, from: number, to: number): Promise<void> {
  for (const line of SCRIPT.slice(from, to)) {
    expect(line, 'a world.hash line is checked, not typed blind').not.toBe('world.hash');
    await runLogged(page, line, (await entries(page)).length);
  }
}

async function openConsole(page: Page): Promise<void> {
  const input = page.getByRole('textbox', { name: 'Console input' });
  await page.keyboard.press('Backquote');
  await expect(input).toBeFocused(); // the toggle's focus moves after a render: wait before typing
}

async function closeConsole(page: Page): Promise<void> {
  await page.keyboard.press('Backquote');
  await expect(page.locator('ctl-viewport canvas')).toBeFocused();
}

/** In the open console: `world.hash` prints `hash`, and the worker's snapshot at the tick is `snapshot`. */
async function expectHashes(page: Page, tick: number, hash: string, snapshot: string): Promise<void> {
  await page.keyboard.insertText('world.hash');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('console-output').locator('.entry').last()).toHaveText(hash);
  expect(await snapshotHash(page)).toBe(snapshot);
  await page.evaluate((t) => (window as unknown as Hooks).__controlsSession?.waitForTick(t), tick);
}

/**
 * The script's tail, typed: the supply conductors, the breaker on, 1.5 s, the lit hashes; off, 0.5 s,
 * the final hashes. Then every logged world command is the script's, in order.
 */
async function finishAndCheck(page: Page, transport: string): Promise<void> {
  const lit = SCRIPT.indexOf('world.hash');
  const out = SCRIPT.lastIndexOf('world.hash');
  expect(SCRIPT[lit - 3]).toMatch(/^wire\.add --a\.entity 1 --a\.terminal n /); // the neutral, last wire
  await typeScript(page, lit - 4, lit);
  const { lampCircuit } = HASHES;
  await expectHashes(page, 1500, lampCircuit.litHash, lampCircuit.litSnapshotHash);
  await typeScript(page, lit + 1, out);
  await expectHashes(page, 2000, lampCircuit.hash, lampCircuit.snapshotHash);
  expect(await worldLines(page)).toStrictEqual(SCRIPT.filter((line) => line !== 'world.hash'));
  expect(await page.evaluate(() => (window as unknown as Hooks).__controlsSession?.simStats() ?? null)).toMatchObject({
    misses: 0,
    transport,
  });
}

/** Settings for new games (Journeyman, a spool in `slot`), then a seed-0 sandbox with its console open. */
async function journeymanSandbox(
  page: Page,
  query: string,
  belt: { slot: number; spool: string } | null,
): Promise<void> {
  await page.goto(`/?e2e=1&renderer=webgl2${query}`);
  await page.getByRole('navigation', { name: 'Controls' }).getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('combobox', { name: 'Default for new games' }).selectOption('journeyman');
  if (belt !== null) {
    await settings
      .getByRole('group', { name: 'Tool belt' })
      .getByRole('combobox', { name: `Slot ${belt.slot}` })
      .selectOption(`${belt.spool}@1`);
  }
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await startSandbox(page);
  await expect(page.locator('ctl-viewport')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  await expect(page.locator('ctl-dev-console [data-editor="ready"]')).toBeAttached();
  await openConsole(page);
}

/** The page position of world point `p` (mm), checked to be on the canvas. */
async function onPage(page: Page, p: Vec, what: string): Promise<{ x: number; y: number }> {
  await page.evaluate(() => (window as unknown as Hooks).__controlsViewport?.whenIdle());
  const box = await page.locator('ctl-viewport canvas').boundingBox();
  const at = await page.evaluate((q) => (window as unknown as Hooks).__controlsViewport?.projectMm(q) ?? null, p);
  if (!box || !at) throw new Error(`${what} is not on the canvas`);
  const point = { x: box.x + at.x, y: box.y + at.y };
  await expectOnCanvas(page, point, what);
  return point;
}

/** From the open console: `view.focus` on `entity-<n>` (a logged view command), back to the canvas. */
async function frame(page: Page, entity: number): Promise<void> {
  await runLogged(page, `view.focus --target entity-${entity}`, (await entries(page)).length);
  await closeConsole(page);
  await expect(page.locator('ctl-viewport')).toHaveAttribute('data-focus', `entity-${entity}`);
}

/** `]` until `entity-<n>` is selected (fixtures come first in the cycle), waiting for each step. */
async function selectEntity(page: Page, n: number): Promise<void> {
  const viewport = page.locator('ctl-viewport');
  for (let i = 0; i < 60; i++) {
    const before = await viewport.getAttribute('data-selected');
    if (before === `entity-${n}`) return;
    await page.keyboard.press('BracketRight');
    await expect.poll(() => viewport.getAttribute('data-selected')).not.toBe(before);
  }
  throw new Error(`entity-${n} was never selected`);
}

/** The palette runs `title` with one id argument typed into its field `field`. */
async function palette(page: Page, title: string, command: string, field: string, id: number): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Command palette' });
  await page.keyboard.press('Control+K');
  await expect(dialog.getByRole('combobox', { name: 'Search commands' })).toBeFocused();
  await page.keyboard.type(title);
  await expect(dialog.getByRole('option').first()).toHaveAttribute('data-command', command);
  await page.keyboard.press('Enter');
  await expect(dialog.getByLabel(field, { exact: true })).toBeFocused();
  await page.keyboard.type(String(id));
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(page.locator('ctl-viewport canvas')).toBeFocused();
}

/**
 * With the landing flow running (the palette's `wiring.land`), picks `terminal` (a click on it, or `]`
 * to its device, Tab and Enter) and fills the prompt as the script's line does: the NM stripper's
 * 14 AWG solid hole at `stripMm`, then (for a screw) the 1-5 N·m driver at `torque`. The flow moves
 * on to the cable's next conductor.
 */
async function land(
  page: Page,
  terminal: { entity: number; terminal: string },
  stripMm: string,
  end: 'a' | 'b',
  torque: string | null,
  pick: 'click' | 'select' = 'click',
): Promise<void> {
  if (pick === 'click') {
    const t = await terminalOnPage(page, terminal);
    await page.mouse.click(t.x, t.y);
  } else {
    // `]` until the device is selected, Tab holds its terminal, Enter picks it.
    await selectEntity(page, terminal.entity);
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('routing-status')).toContainText(`#${terminal.entity}, terminal`);
    await expect(page.getByTestId('routing-status')).toContainText('Enter picks it.');
    await page.keyboard.press('Enter');
  }
  const strip = page.getByRole('dialog', { name: `End ${end}: strip and finish` });
  await expect(strip).toBeVisible();
  await strip.getByRole('combobox', { name: 'Stripper' }).selectOption(NM_STRIPPER);
  await strip.getByRole('combobox', { name: 'Strip hole' }).selectOption({ label: '14 AWG solid' });
  await strip.getByRole('textbox', { name: 'Strip length (mm)' }).fill(stripMm);
  if (torque === null) {
    await strip.getByRole('button', { name: `Land end ${end}` }).click();
  } else {
    await strip.getByRole('button', { name: 'Next' }).click();
    const tighten = page.getByRole('dialog', { name: `End ${end}: tighten` });
    await tighten.getByRole('combobox', { name: 'Screwdriver' }).selectOption(BIG_DRIVER);
    await tighten.getByRole('textbox', { name: 'Torque setting (N·m)' }).fill(torque);
    await tighten.getByRole('button', { name: `Land end ${end}` }).click();
  }
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.locator('ctl-viewport canvas')).toBeFocused();
}

for (const { transport, query } of [
  { transport: 'sab', query: '' },
  // The postMessage fallback (ADR 0011 §8): the same bytes, so the same hashes.
  { transport: 'message', query: '&sab=0' },
] as const) {
  test(`the lamp circuit (${transport}): cable 2 run, stripped and landed with the mouse and keyboard, at the sim-cli hashes`, async ({
    page,
  }) => {
    test.slow(); // about 40 console lines, two framings and seven prompts under software WebGL2
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console: ${m.text()}`);
    });
    await page.setViewportSize({ width: 1280, height: 720 });
    await journeymanSandbox(page, query, { slot: 5, spool: NMB });
    const viewport = page.locator('ctl-viewport');
    const status = page.getByTestId('routing-status');
    const hint = page.getByTestId('routing-hint');
    const cable2 = SCRIPT.findIndex((line) => line.startsWith('cable.add --a.entity 7 '));
    expect(cable2).toBe(16);

    // The supply, the panel and its devices, the jumper, both boxes and cable 1, from the console.
    await typeScript(page, 0, cable2);

    // Cable 2 with the gesture. Framed on the junction box and stepped back as far as the camera goes,
    // its bottom clamp and studs 4 and 5 are in view; the lamp box and stud 6 after a second framing.
    await frame(page, 7);
    const centre = await onPage(page, { x: -835, y: -850, z: -21 }, 'the junction box');
    await page.mouse.move(centre.x, centre.y);
    for (let i = 0; i < 16; i++) await page.mouse.wheel(0, 200);
    await page
      .getByRole('toolbar', { name: 'Tool belt' })
      .getByRole('button', { name: /^5: NM-B 14\/2/ })
      .click();
    await expect(viewport).toHaveAttribute('data-routing', 'armed');
    // The box's front face just above its bottom: the nearest open entry is the bottom clamp (the top
    // clamp holds cable 1).
    const clamp = await onPage(page, { x: -807, y: -840, z: 55 }, 'the junction box above its bottom clamp');
    await page.mouse.click(clamp.x, clamp.y);
    await expect(status).toHaveText(
      'From 2-gang nonmetallic new-work device box #7, entry clamp-bottom-1. Add staples, then pick the far entry.',
    );
    // Head-on clicks on the studs' front faces at y = -1000: right of stud 4's centre line (x -855) its
    // right side's staple, on stud 5's centre line (x -449) the bore, left of stud 6's (x -43) its left
    // side's staple, each 44 mm behind the face.
    const waypoints = [
      { at: { x: -841, y: -1000, z: -21 }, kind: 'staple' },
      { at: { x: -449, y: -1000, z: -21 }, kind: 'bore' },
    ] as const;
    for (const [n, { at, kind }] of waypoints.entries()) {
      const p = await onPage(page, at, `the stud at x ${at.x}`);
      await page.mouse.move(p.x, p.y);
      await expect(hint).toContainText(`A click adds a ${kind} waypoint.`);
      await page.mouse.click(p.x, p.y);
      await expect(status).toHaveText(`Waypoint ${n + 1} added (${kind} waypoint).`);
    }
    await openConsole(page);
    await frame(page, 8);
    await expect(viewport).toHaveAttribute('data-routing', 'started'); // the console framing kept the gesture
    const box8 = await onPage(page, { x: -165, y: -850, z: -21 }, 'the lamp box');
    await page.mouse.move(box8.x, box8.y);
    for (let i = 0; i < 16; i++) await page.mouse.wheel(0, 200);
    const stud6 = await onPage(page, { x: -58, y: -1000, z: -21 }, 'stud 6');
    await page.mouse.move(stud6.x, stud6.y);
    await expect(hint).toContainText('A click adds a staple waypoint.');
    await page.mouse.click(stud6.x, stud6.y);
    await expect(status).toHaveText('Waypoint 3 added (staple waypoint).');
    const lampClamp = await onPage(page, { x: -137, y: -840, z: 55 }, 'the lamp box above its bottom clamp');
    await page.mouse.click(lampClamp.x, lampClamp.y);
    // The strip prompt opens on the new cable; the script strips cable 1 first, so not yet.
    const strip = page.getByRole('dialog', { name: 'Strip cable 2' });
    await expect(strip).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(strip).toBeHidden();
    expect(await worldLines(page)).toStrictEqual(SCRIPT.slice(0, cable2 + 1));
    await page.keyboard.press('Escape'); // the spool away
    await expect(viewport).not.toHaveAttribute('data-routing', /.+/);

    // Cable 1's jackets from the console, then cable 2's in the strip prompt, from the keyboard.
    await openConsole(page);
    await typeScript(page, cable2 + 1, cable2 + 3);
    await closeConsole(page);
    // Shift+N selects the last drawn wire, cable 2 (routed conductors, then cables, by id); J strips it.
    await page.keyboard.press('Shift+KeyN');
    await expect
      .poll(() => page.evaluate(() => (window as unknown as Hooks).__controlsViewport?.state.selectedWire ?? null))
      .toStrictEqual({ kind: 'cable', id: 2 });
    await page.keyboard.press('KeyJ');
    await expect(strip).toBeVisible();
    await strip.getByRole('combobox', { name: 'Cable stripper' }).selectOption(NM_STRIPPER);
    await strip.getByRole('textbox', { name: 'End a: jacket to strip (mm)' }).fill('150');
    await strip.getByRole('textbox', { name: 'End b: jacket to strip (mm)' }).fill('150');
    await page.keyboard.press('Enter');
    await expect(strip).toBeHidden();
    await expect(status).toContainText('Cable 2 stripped: end a 150 mm, end b 150 mm.');
    expect(await worldLines(page)).toStrictEqual(SCRIPT.slice(0, cable2 + 5));

    // Cable 1 landed in the panel, the wire nuts placed and cable 1's black twisted into the first, from
    // the console; cable 2's ends at the junction box with the landing prompts, interleaved as scripted.
    const nuts = SCRIPT.findIndex((line) => line.includes('--at.entity 9 --at.terminal splice'));
    await openConsole(page);
    await typeScript(page, cable2 + 5, nuts + 1);
    for (const [k, [wire, nut]] of [
      [5, 9],
      [6, 10],
      [7, 11],
    ].entries()) {
      if (k > 0) {
        await openConsole(page);
        await typeScript(page, nuts + 2 * k, nuts + 2 * k + 1); // cable 1's conductor into the nut
      }
      await frame(page, 7);
      await palette(page, 'Land a cable conductor', 'wiring.land', 'Conductor', wire);
      await expect(status).toContainText(`(wire ${wire})`);
      await land(page, { entity: nut, terminal: 'splice' }, '13', 'a', null, 'select');
      await expect(status).toContainText(`Wire ${wire} end a landed on`);
      await page.keyboard.press('Escape'); // stop: the script's next line is the console's
      await expect(viewport).not.toHaveAttribute('data-routing', /.+/);
    }
    expect(await worldLines(page)).toStrictEqual(SCRIPT.slice(0, nuts + 6));

    // The lamp from the console; cable 2's black and white on its screws, one landing after the other.
    await openConsole(page);
    await typeScript(page, nuts + 6, nuts + 7);
    await frame(page, 12);
    await palette(page, 'Land a cable conductor', 'wiring.land', 'Conductor', 5);
    await land(page, { entity: 12, terminal: 'a' }, '16', 'b', '1.8');
    await expect(status).toContainText('Wire 5 end b landed on');
    await expect(status).toContainText('Next: the white');
    await land(page, { entity: 12, terminal: 'b' }, '16', 'b', '1.8');
    await expect(status).toContainText('Wire 6 end b landed on');
    await page.keyboard.press('Escape'); // the bare EGC stays folded back at the lamp box
    await expect(viewport).not.toHaveAttribute('data-routing', /.+/);
    expect(await worldLines(page)).toStrictEqual(SCRIPT.slice(0, nuts + 9));

    await openConsole(page);
    await finishAndCheck(page, transport);
    expect(errors).toStrictEqual([]);
  });
}

test('keyboard only: the panel jumper is routed with Tab / Shift+Tab, Enter and the prompts, at the sim-cli hashes', async ({
  page,
}) => {
  test.slow(); // about 40 console lines under software WebGL2
  // Every pointer press from the first document script on: none may happen in this test.
  await page.addInitScript(() => {
    const w = window as unknown as { __pointerPresses: number };
    w.__pointerPresses = 0;
    for (const type of ['pointerdown', 'mousedown', 'touchstart'])
      window.addEventListener(type, () => (w.__pointerPresses += 1), { capture: true });
  });
  const presses = () => page.evaluate(() => (window as unknown as { __pointerPresses: number }).__pointerPresses);
  await page.goto('/?e2e=1&renderer=webgl2');
  const menu = page.getByRole('navigation', { name: 'Controls' });
  await expect(menu.getByRole('button', { name: 'New sandbox' })).toBeFocused(); // the menu takes focus at boot
  await tabTo(page, menu.getByRole('button', { name: 'Settings' }));
  await page.keyboard.press('Enter');
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('combobox', { name: 'Default for new games' }).selectOption('journeyman');
  await settings
    .getByRole('group', { name: 'Tool belt' })
    .getByRole('combobox', { name: 'Slot 4' })
    .selectOption(`${THHN}@1`);
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await tabTo(page, menu.getByRole('button', { name: 'New sandbox' }), 15, 'Shift+Tab');
  await page.keyboard.press('Enter');
  await enterSeed(page);
  await expect(page.locator('ctl-viewport')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  await expect(page.locator('ctl-dev-console [data-editor="ready"]')).toBeAttached();
  await openConsole(page);

  // The supply, the panel, its knockouts, the breaker, the blocks and the label, from the console.
  const jumper = SCRIPT.findIndex((line) => line.startsWith('wire.add --a.entity 3 --a.terminal load '));
  expect(jumper).toBe(9);
  await typeScript(page, 0, jumper);
  await closeConsole(page);

  const viewport = page.locator('ctl-viewport');
  const status = page.getByTestId('routing-status');
  await page.keyboard.press('Digit4'); // the THHN spool
  await expect(viewport).toHaveAttribute('data-routing', 'armed');
  // End a: the breaker's load screw. Tab and Shift+Tab move through its terminals; Enter picks.
  await selectEntity(page, 3);
  await page.keyboard.press('Tab');
  await expect(status).toHaveText(
    'Terminal: 15 A single-pole thermal-magnetic circuit breaker on a base #3, terminal LINE. Enter picks it.',
  );
  await page.keyboard.press('Tab');
  await expect(status).toContainText('#3, terminal LOAD. Enter picks it.');
  await page.keyboard.press('Shift+Tab');
  await expect(status).toContainText('#3, terminal LINE. Enter picks it.');
  await page.keyboard.press('Tab');
  await expect(status).toContainText('#3, terminal LOAD. Enter picks it.');
  await page.keyboard.press('Enter');
  // Its prompt: the general stripper (the default), its 14 AWG solid hole, 13 mm; the 1-5 N·m torque
  // screwdriver chosen by type-ahead (the default 0.3-1.2 N·m one can't reach the marked 4 N·m), 4 N·m.
  await terminateByKeyboard(page, 'a', '13', 'Torque screwdriver, 1', BIG_DRIVER, '4');
  await expect(viewport).toHaveAttribute('data-routing', 'started');
  await expect(status).toContainText('(screw clamp). Pick the second terminal.');
  // End b: the line block's top clamp (terminal 1), auto-routed: the straight line.
  await selectEntity(page, 4);
  await page.keyboard.press('Tab');
  await expect(status).toContainText('#4, terminal 1. Enter picks it.');
  await page.keyboard.press('Enter');
  await terminateByKeyboard(page, 'b', '9', null, 'tool.calderyn-ts-03@1', '0.6');
  await expect(status).toContainText('Wire added from');
  expect(await worldLines(page)).toStrictEqual(SCRIPT.slice(0, jumper + 1));
  await page.keyboard.press('Escape'); // the spool away
  await expect(viewport).not.toHaveAttribute('data-routing', /.+/);

  // Everything else from the console, then the hashes.
  await openConsole(page);
  await typeScript(page, jumper + 1, SCRIPT.indexOf('world.hash') - 4);
  await finishAndCheck(page, 'sab');
  expect(await presses()).toBe(0);
});

/**
 * One end's termination prompt from the keyboard: Tab to the hole, type-ahead "14", Tab, the strip
 * length, Enter; then the driver (type-ahead `driverTypeAhead`, or the default), Tab, the torque, Enter.
 */
async function terminateByKeyboard(
  page: Page,
  end: 'a' | 'b',
  stripMm: string,
  driverTypeAhead: string | null,
  driver: string,
  torque: string,
): Promise<void> {
  const strip = page.getByRole('dialog', { name: `End ${end}: strip and finish` });
  await expect(strip.getByRole('combobox', { name: 'Method' })).toBeFocused();
  await expect(strip.getByRole('combobox', { name: 'Stripper' })).toHaveValue('tool.veltmark-ws-1018@1');
  await page.keyboard.press('Tab'); // Stripper
  await page.keyboard.press('Tab'); // Strip hole
  const hole = strip.getByRole('combobox', { name: 'Strip hole' });
  await expect(hole).toBeFocused();
  // Type-ahead, never arrows: on macOS an arrow on a closed <select> opens its menu (docs/caveats/ui.md).
  await page.keyboard.type('14');
  await expect(hole).toHaveValue('sol14');
  await page.keyboard.press('Tab');
  await expect(strip.getByRole('textbox', { name: 'Strip length (mm)' })).toBeFocused();
  await page.keyboard.type(stripMm);
  await page.keyboard.press('Enter');
  const tighten = page.getByRole('dialog', { name: `End ${end}: tighten` });
  const screwdriver = tighten.getByRole('combobox', { name: 'Screwdriver' });
  await expect(screwdriver).toBeFocused();
  if (driverTypeAhead !== null) await page.keyboard.type(driverTypeAhead);
  await expect(screwdriver).toHaveValue(driver);
  await page.keyboard.press('Tab');
  await expect(tighten.getByRole('textbox', { name: 'Torque setting (N·m)' })).toBeFocused();
  await page.keyboard.type(torque);
  await page.keyboard.press('Enter');
  await expect(tighten).toBeHidden();
  await expect(page.locator('ctl-viewport canvas')).toBeFocused();
}

for (const { transport, query } of [
  { transport: 'sab', query: '' },
  { transport: 'message', query: '&sab=0' },
] as const) {
  test(`bad-termination.console replayed in the game (${transport}) reaches the sim-cli hashes`, async ({ page }) => {
    test.slow(); // 600 s of sim time in the worker
    await journeymanSandbox(page, query, null);
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.type('run');
    await page.keyboard.press('Enter');
    const text = readFileSync(join(SCENARIOS, 'bad-termination.console'));
    await (await chooser).setFiles({ name: 'bad-termination.console', mimeType: 'text/plain', buffer: text });
    const output = page.getByTestId('console-output').locator('.entry');
    await expect(output.last()).toHaveText('Ran 43 commands from bad-termination.console.', { timeout: 60_000 });
    await expectHashes(page, 600_000, HASHES.badTermination.hash, HASHES.badTermination.snapshotHash);
    expect(await page.evaluate(() => (window as unknown as Hooks).__controlsSession?.simStats() ?? null)).toMatchObject(
      { misses: 0, transport },
    );
  });
}

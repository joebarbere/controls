import { expect, type Page, test } from '@playwright/test';
import { expectOnCanvas, terminalOnPage } from './support/aim';
import { closeConsole, expectDrawn, runLogged } from './support/console';
import { startSandbox } from './support/sandbox';

/**
 * F3.2 part 4's acceptance: a box-to-box NM-B run on the workshop's stud wall, played with the mouse
 * and the keyboard at Apprentice (prompts preselected, D9). A 2-gang nonmetallic box against stud 4 and
 * a DIN panel hung on the studs above it (their entries opened, three terminal blocks on the panel's
 * lower rail, all from the console, seed 0); the 14/2 NM-B spool on belt slot 5:
 *
 * - the cable gesture: the box's top clamp, two staples on stud 4, the panel's bottom knockout; one
 *   `cable.add` with the default 200 mm tails;
 * - the strip prompt that follows: both ends stripped to the most a box allows (193 mm), one
 *   `cable.strip` per end (one more is refused inside the prompt);
 * - landing: the palette's `wiring.land` starts on the black conductor (then Escape stops it); a click
 *   on the knockout's tails (head-on they line up, and the bare EGC is in front) selects the bare one
 *   and L lands it; each terminal pick's prompt (Next, Land) logs one `wire.land`, and the black and
 *   the white follow by themselves.
 *
 * The full logged entry list and `world.hash` are pinned, and the world commands typed into the
 * console of a fresh sandbox reach the same hash. Pixel-aimed, so 1280 × 720 and every click checked
 * on the canvas (`support/aim.ts`).
 */

/** `world.hash` after the run (pinned from this spec; the console twin below reaches it too). */
const RUN_HASH = 'b387f2f94728b1fba1024d2fe3f7d81b621f83fb84cabdcba7230b397f251650';

const NMB = 'cable.sorrelby-nmb-14-2';
const SPOOL_BUTTON = '5: NM-B 14/2 with ground, copper, 600 V (spool)';
const SETUP = [
  'entity.place --ref.id box.tinmoor-2g-nm --ref.version 1 --positionMm.x -835 --positionMm.y -150 --positionMm.z -21',
  'enclosure.openEntry --id 1 --entry clamp-top-1 --tool.id tool.veltmark-sd-2 --tool.version 1',
  'entity.place --ref.id panel.pellmoor-din-400x500 --ref.version 1 --positionMm.x -1010 --positionMm.y 200 --positionMm.z -21',
  'enclosure.openEntry --id 2 --entry ko-bottom-2 --tool.id tool.veltmark-sd-2 --tool.version 1',
  ...[
    ['tb.quennick-st4', -819],
    ['tb.quennick-st4', -813],
    ['tb.quennick-pe4', -807],
  ].map(
    ([id, x]) =>
      `entity.place --ref.id ${id} --ref.version 1 --positionMm.x ${x} --positionMm.y 351 --positionMm.z 1 ` +
      '--mountedOn.entity 2 --mountedOn.mount rail-2',
  ),
];

const ref = (id: string) => JSON.stringify({ id, version: 1 });
const UPRIGHT = '--orientationMdeg {"yaw":0,"pitch":0,"roll":0}';
const staple = (y: number) =>
  `{"kind":"staple","positionMm":{"x":-835,"y":${y},"z":-65},"entity":null,"fixture":"stud-wall","tool":null}`;
/** Apprentice's preselected termination on the blocks' bottom clamps (`suggestTermination`). */
const TERMINATION =
  `{"method":"screw","strip":{"tool":${ref('tool.veltmark-ws-1018')},"hole":"sol14","lengthMm":9},` +
  `"accessory":null,"clamp":{"tool":${ref('tool.calderyn-ts-03')},"torqueNm":0.6}}`;
/** Every logged entry of the run, as console lines (`consoleLine`). */
const RUN_LOG = [
  `entity.place --ref ${ref('box.tinmoor-2g-nm')} --positionMm {"x":-835,"y":-150,"z":-21} ${UPRIGHT} --mountedOn null --inEntry null`,
  `enclosure.openEntry --id 1 --entry clamp-top-1 --tool ${ref('tool.veltmark-sd-2')}`,
  `entity.place --ref ${ref('panel.pellmoor-din-400x500')} --positionMm {"x":-1010,"y":200,"z":-21} ${UPRIGHT} ` +
    '--mountedOn null --inEntry null',
  `enclosure.openEntry --id 2 --entry ko-bottom-2 --tool ${ref('tool.veltmark-sd-2')}`,
  ...[
    ['tb.quennick-st4', -819],
    ['tb.quennick-st4', -813],
    ['tb.quennick-pe4', -807],
  ].map(
    ([id, x]) =>
      `entity.place --ref ${ref(String(id))} --positionMm {"x":${x},"y":351,"z":1} ${UPRIGHT} ` +
      '--mountedOn {"entity":2,"mount":"rail-2"} --inEntry null',
  ),
  'view.focus --target entity-2',
  'toolbelt.select --slot 5',
  `cable.add --ref ${ref(NMB)} --a {"entity":1,"entry":"clamp-top-1"} --b {"entity":2,"entry":"ko-bottom-2"} ` +
    `--route [${staple(0)},${staple(130)}] --lengthMm 818 --tailsMm {"a":200,"b":200} ` +
    `--tool ${ref('tool.veltmark-dc-8')}`,
  `cable.strip --id 1 --end a --jacketMm 193 --tool ${ref('tool.veltmark-ws-nm12')}`,
  `cable.strip --id 1 --end b --jacketMm 193 --tool ${ref('tool.veltmark-ws-nm12')}`,
  'view.focus --target entity-2',
  'view.focus --target entity-4',
  ...[3, 1, 2].map(
    (id) => `wire.land --id ${id} --end b --at {"entity":${id + 2},"terminal":"b","termination":${TERMINATION}}`,
  ),
];

type Vec = { x: number; y: number; z: number };
type Entry = { id: string; args: Record<string, unknown> };
type Hooks = {
  __controlsViewport?: {
    whenIdle(): Promise<void>;
    projectMm(p: Vec): { x: number; y: number } | undefined;
    state: { selectedWire: { kind: string; id: number } | null };
  };
  __controlsSession?: { entries(): readonly Entry[]; hash(): Promise<string> };
};

const entries = (page: Page) =>
  page.evaluate(() => ((window as unknown as Hooks).__controlsSession?.entries() ?? []).map((e) => ({ ...e })));
const hash = (page: Page) => page.evaluate(() => (window as unknown as Hooks).__controlsSession?.hash() ?? '');

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

/** Opens a seed-0 sandbox and focuses its console (settings as they are). */
async function openSandbox(page: Page): Promise<void> {
  await startSandbox(page);
  await expect(page.locator('ctl-viewport')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  await expect(page.locator('ctl-dev-console [data-editor="ready"]')).toBeAttached();
  await page.keyboard.press('Backquote');
  await expect(page.getByRole('textbox', { name: 'Console input' })).toBeFocused();
}

/** Settings: Apprentice for new games and the NM-B spool in slot 5; a seed-0 sandbox set up from the console. */
async function sandbox(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?e2e=1&renderer=webgl2');
  await page.getByRole('navigation', { name: 'Controls' }).getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('combobox', { name: 'Default for new games' }).selectOption('apprentice');
  await settings
    .getByRole('group', { name: 'Tool belt' })
    .getByRole('combobox', { name: 'Slot 5' })
    .selectOption(`${NMB}@1`);
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await openSandbox(page);
  for (const [seq, line] of SETUP.entries()) await runLogged(page, line, seq);
  await expectDrawn(page, ['entity-1', 'entity-2', 'entity-3', 'entity-4', 'entity-5']);
}

/** A logged command as one console line (top-level values as words, objects and lists as JSON words). */
function consoleLine(entry: Entry): string {
  const words = Object.entries(entry.args).map(
    ([k, v]) => `--${k} ${v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v)}`,
  );
  return [entry.id, ...words].join(' ');
}

const WORLD_COMMANDS = new Set(['entity.place', 'enclosure.openEntry', 'cable.add', 'cable.strip', 'wire.land']);

test('a box-to-box NM-B run: staples, the jacket stripped at both ends, and three conductors landed', async ({
  page,
}) => {
  test.slow(); // the played run, then a second page replaying it: about 30 s under a full suite's load
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  await sandbox(page);
  // Frame the panel, then step back so the box below it is in view too.
  await runLogged(page, 'view.focus --target entity-2', SETUP.length);
  await closeConsole(page); // the full-height canvas before its box is measured
  const canvas = page.locator('ctl-viewport canvas');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const wheelAt = { x: (box as { x: number }).x + 400, y: (box as { y: number }).y + 300 };
  await expectOnCanvas(page, wheelAt, 'the zoom-out point'); // a wheel over an overlay would scroll it
  await page.mouse.move(wheelAt.x, wheelAt.y);
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 200);

  const viewport = page.locator('ctl-viewport');
  const status = page.getByTestId('routing-status');
  const hint = page.getByTestId('routing-hint');
  await page.getByRole('toolbar', { name: 'Tool belt' }).getByRole('button', { name: SPOOL_BUTTON }).click();
  await expect(viewport).toHaveAttribute('data-routing', 'armed');
  await expect(hint).toContainText('click an open entry on a box or panel');

  // The box's front face just under its open top clamp: the nearest open entry is the clamp.
  const clamp = await onPage(page, { x: -807, y: -70, z: 55 }, 'the box under its top clamp');
  await page.mouse.click(clamp.x, clamp.y);
  await expect(status).toHaveText(
    'From 2-gang nonmetallic new-work device box #1, entry clamp-top-1. Add staples, then pick the far entry.',
  );
  await expect(viewport).toHaveAttribute('data-routing', 'started');
  // The support rule is shown before anything is logged.
  await expect(hint).toContainText('No staple secures the cable near the box at end a');
  // Two staples on stud 4's side face (a head-on click on the right half of its front face).
  for (const [n, y] of [0, 130].entries()) {
    const stud = await onPage(page, { x: -841, y, z: -21 }, `stud 4 at y ${y}`);
    await page.mouse.move(stud.x, stud.y);
    await expect(hint).toContainText('A click adds a staple waypoint.');
    await page.mouse.click(stud.x, stud.y);
    await expect(status).toHaveText(`Waypoint ${n + 1} added (staple waypoint).`);
  }
  await expect(hint).not.toContainText('No staple');
  // The panel's front face just above its bottom: the nearest open entry is the middle knockout.
  const knockout = await onPage(page, { x: -810, y: 215, z: 179 }, 'the panel above its bottom knockout');
  await page.mouse.click(knockout.x, knockout.y);

  // The strip prompt opens on the new cable, prefilled at Apprentice with the most a box allows.
  const strip = page.getByRole('dialog', { name: 'Strip cable 1' });
  await expect(strip).toBeVisible();
  const endB = strip.getByRole('textbox', { name: 'End b: jacket to strip (mm)' });
  await expect(strip.getByRole('textbox', { name: 'End a: jacket to strip (mm)' })).toHaveValue('193');
  await expect(endB).toHaveValue('193');
  await expect(strip.getByRole('combobox', { name: 'Cable stripper' })).toHaveValue('tool.veltmark-ws-nm12@1');
  // One more than the box allows is refused inside the prompt; nothing is logged.
  await endB.fill('194');
  await page.keyboard.press('Enter');
  await expect(strip.getByRole('alert')).toContainText('(strip-too-long)');
  await endB.fill('193');
  await page.keyboard.press('Enter');
  await expect(strip).toBeHidden();
  await expect(canvas).toBeFocused();
  await expect(status).toContainText('Cable 1 stripped: end a 193 mm, end b 193 mm.');
  // Escape puts the spool away, and Tab moves focus off the canvas again (no routing key holds it).
  await page.keyboard.press('Escape');
  await expect(viewport).not.toHaveAttribute('data-routing', /.+/);
  await page.keyboard.press('Tab');
  await expect(canvas).not.toBeFocused();
  await canvas.focus();

  // Frame the panel. The palette starts landing a conductor by number, keyboard only (the black, wire 1);
  // Escape stops it again, with nothing logged.
  await page.keyboard.press('Backquote');
  await expect(page.getByRole('textbox', { name: 'Console input' })).toBeFocused();
  await runLogged(page, 'view.focus --target entity-2', (await entries(page)).length);
  await page.keyboard.press('Backquote');
  await expect(canvas).toBeFocused();
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await page.keyboard.press('Control+K');
  await expect(palette.getByRole('combobox', { name: 'Search commands' })).toBeFocused();
  await page.keyboard.type('Land a cable conductor');
  await expect(palette.getByRole('option').first()).toHaveAttribute('data-command', 'wiring.land');
  await page.keyboard.press('Enter');
  const form = palette.getByRole('form', { name: /^Arguments for Land a cable conductor/ });
  await expect(form.getByRole('textbox', { name: 'Conductor' })).toBeFocused();
  await page.keyboard.type('1');
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
  await expect(canvas).toBeFocused();
  await expect(status).toContainText('Landing the black conductor 1 of cable 1 (wire 1)');
  await expect(viewport).toHaveAttribute('data-routing', 'armed');
  await page.keyboard.press('Escape');
  await expect(viewport).not.toHaveAttribute('data-routing', /.+/);

  // A click on the tails above the bottom knockout: head-on they line up one behind the other, and the
  // front one (the bare EGC, wire 3) is picked over the tails behind it and the panel behind them all,
  // on them or a few pixels beside them. L on the selected conductor lands it.
  const tail = await onPage(page, { x: -810, y: 300, z: 82 }, 'the tails above the bottom knockout');
  await page.mouse.click(tail.x + 2, tail.y);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Hooks).__controlsViewport?.state.selectedWire ?? null))
    .toStrictEqual({ kind: 'connection', id: 3 });
  // `selection.connectionId` (L's `when`) is published with the renderer's selection, so L works at once.
  await page.keyboard.press('KeyL');
  await expect(status).toContainText('Landing the bare conductor 3 of cable 1 (wire 3)');
  await expect(viewport).toHaveAttribute('data-routing', 'armed');

  // The blocks' terminals are a few pixels apart here: frame block 4 with Z, then pick each bottom clamp.
  const crowded = await terminalOnPage(page, { entity: 4, terminal: 'b' });
  await page.mouse.move(crowded.x, crowded.y);
  await expect(hint).toContainText('Z zooms in.');
  await page.keyboard.press('KeyZ');
  await expect(viewport).toHaveAttribute('data-focus', 'entity-4');
  for (const [wire, block, next] of [
    [3, 5, 'Next: the black conductor'],
    [1, 3, 'Next: the white conductor'],
    [2, 4, 'Every conductor of cable 1 is landed at end b.'],
  ] as const) {
    const t = await terminalOnPage(page, { entity: block, terminal: 'b' });
    await page.mouse.click(t.x, t.y);
    const finish = page.getByRole('dialog', { name: 'End b: strip and finish' });
    await expect(finish).toBeVisible();
    await finish.getByRole('button', { name: 'Next' }).click();
    const tighten = page.getByRole('dialog', { name: 'End b: tighten' });
    await tighten.getByRole('button', { name: 'Land end b' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(canvas).toBeFocused(); // focus returns to the canvas after each prompt
    await expect(status).toContainText(`Wire ${wire} end b landed on`);
    await expect(status).toContainText(next);
  }
  await expect(viewport).not.toHaveAttribute('data-routing', /.+/);

  // The full log, as console lines: the setup, the gesture's one cable.add, a strip per end, and a
  // wire.land per conductor (Apprentice's preselected termination, F3.3 part 2).
  const logged = await entries(page);
  expect(logged.map(consoleLine)).toStrictEqual(RUN_LOG);
  expect(await hash(page)).toBe(RUN_HASH);
  expect(errors).toStrictEqual([]);

  // The console twin: the world commands typed into a fresh sandbox's console reach the same hash. A
  // second page of the same context keeps the settings (Apprentice), which the world records.
  const lines = logged.filter((e) => WORLD_COMMANDS.has(e.id)).map(consoleLine);
  expect(lines).toHaveLength(13);
  const twin = await page.context().newPage();
  const twinErrors: string[] = [];
  twin.on('pageerror', (error) => twinErrors.push(`pageerror: ${error.message}`));
  twin.on('console', (m) => {
    if (m.type() === 'error') twinErrors.push(`console: ${m.text()}`);
  });
  await page.close(); // one game at a time: the twin never shares a page with the played run
  await twin.setViewportSize({ width: 1280, height: 720 });
  await twin.goto('/?e2e=1&renderer=webgl2');
  await openSandbox(twin);
  for (const [seq, line] of lines.entries()) await runLogged(twin, line, seq);
  expect(await hash(twin)).toBe(RUN_HASH);
  expect(twinErrors).toStrictEqual([]);
});

test('keyboard: a selected box’s entries are cycled with Tab and picked with Enter; Backspace clears it', async ({
  page,
}) => {
  await sandbox(page);
  await page.keyboard.press('Backquote');
  const viewport = page.locator('ctl-viewport');
  const canvas = page.locator('ctl-viewport canvas');
  const status = page.getByTestId('routing-status');
  await canvas.focus();
  await page.keyboard.press('Digit5');
  await expect(viewport).toHaveAttribute('data-routing', 'armed');
  // `]` until the box (entity 1) is selected (fixtures come first in the cycle).
  for (let i = 0; i < 40; i++) {
    const before = await viewport.getAttribute('data-selected');
    if (before === 'entity-1') break;
    await page.keyboard.press('BracketRight');
    await expect.poll(() => viewport.getAttribute('data-selected')).not.toBe(before);
  }
  await expect(viewport).toHaveAttribute('data-selected', 'entity-1');
  // The top clamp is the box's first entry; the second is closed, and says so.
  await page.keyboard.press('Tab');
  await expect(status).toHaveText(
    'Entry: 2-gang nonmetallic new-work device box #1, entry clamp-top-1. Enter picks it.',
  );
  await page.keyboard.press('Tab');
  await expect(status).toContainText('entry clamp-top-2. Entry "clamp-top-2" of entity 1 is closed.');
  await page.keyboard.press('Shift+Tab');
  await expect(status).toContainText('entry clamp-top-1. Enter picks it.');
  await page.keyboard.press('Enter');
  await expect(status).toHaveText(
    'From 2-gang nonmetallic new-work device box #1, entry clamp-top-1. Add staples, then pick the far entry.',
  );
  await expect(viewport).toHaveAttribute('data-routing', 'started');
  await page.keyboard.press('Backspace');
  await expect(status).toHaveText('First entry cleared. Pick the first entry.');
  await expect(viewport).toHaveAttribute('data-routing', 'armed');
  // Escape puts the spool away, and Tab moves focus out of the canvas again.
  await page.keyboard.press('Escape');
  await expect(viewport).not.toHaveAttribute('data-routing', /.+/);
  await expect(canvas).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(canvas).not.toBeFocused();
  expect((await entries(page)).map((e) => e.id).slice(SETUP.length)).toStrictEqual(['toolbelt.select']);
});

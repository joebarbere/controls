import { expect, type Page, test } from '@playwright/test';
import { expectDrawn, runLogged } from './support/console';
import { startSandbox } from './support/sandbox';

/**
 * F3.2 part 3, renderer half (ADR 0017 §9): the terminal picker and the routing gesture's picks in
 * Chromium on WebGL2 (what CI runs), driven by the real mouse and keyboard and read through the
 * renderer's `?e2e=1` hook. Three 4 mm² screw blocks stand 40 mm in front of the workshop backplate.
 * At the default framing their 6 mm pitch is a few pixels, so the hover offers the zoom; `view.focus`
 * on a block makes the pitch at least 24 px, then a click picks a terminal and the routing session
 * reports it; Tab to the third block's terminal and Enter picks it with the proposal `wire.add` would
 * take. None of this logs a command: the UI half turns the picks into one `wire.add`.
 */

type TerminalRef = { entity: number; terminal: string };
type TerminalView = { hit: TerminalRef | null; zoomSuggested: boolean; device: number | null };
type Hook = {
  focus(id: string): boolean;
  select(id: string | null): boolean;
  whenIdle(): Promise<void>;
  projectTerminal(ref: TerminalRef): { x: number; y: number } | null;
  terminalPitchPx(entity: number): number | null;
  setRouting(session: unknown): void;
  onRouting(listener: (event: unknown) => void): () => void;
  cycleTerminal(step: 1 | -1): TerminalRef | null;
  state: { terminal: TerminalView | null } | undefined;
  routingMarkers(): readonly { kind: string }[];
};
type Win = { __controlsViewport?: Hook; __routingEvents?: unknown[] };

const BLOCK = '--ref.id tb.quennick-st4 --ref.version 1';
const SPOOL = {
  ref: { id: 'conductor.tallowmere-thhn-14-solid', version: 1 },
  colour: { base: 'black', stripe: null },
};

const idle = (page: Page) => page.evaluate(() => (window as unknown as Win).__controlsViewport?.whenIdle());
const pitchOf = (page: Page, entity: number) =>
  page.evaluate((e) => (window as unknown as Win).__controlsViewport?.terminalPitchPx(e) ?? null, entity);
const terminalView = (page: Page) =>
  page.evaluate(() => (window as unknown as Win).__controlsViewport?.state?.terminal ?? null);
const routingEvents = (page: Page) => page.evaluate(() => (window as unknown as Win).__routingEvents ?? []);
const markers = (page: Page) =>
  page.evaluate(() => (window as unknown as Win).__controlsViewport?.routingMarkers().map((m) => m.kind) ?? []);

/** The page position of a terminal's entry point. */
async function terminalOnPage(page: Page, ref: TerminalRef): Promise<{ x: number; y: number }> {
  const box = await page.locator('ctl-viewport canvas').boundingBox();
  const p = await page.evaluate((r) => (window as unknown as Win).__controlsViewport?.projectTerminal(r) ?? null, ref);
  if (!box || !p) throw new Error('terminal not on the canvas');
  return { x: box.x + p.x, y: box.y + p.y };
}

test('terminals are picked in screen space, the zoom is offered under 24 px, and routing reports picks (F3.2 part 3)', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?e2e=1&renderer=webgl2');
  await startSandbox(page);
  await expect(page.locator('ctl-viewport')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  await expect(page.locator('ctl-dev-console [data-editor="ready"]')).toBeAttached();
  await page.keyboard.press('Backquote');
  await expect(page.getByRole('textbox', { name: 'Console input' })).toBeFocused();
  for (const [seq, x] of [-100, -94, -88].entries()) {
    await runLogged(page, `entity.place ${BLOCK} --positionMm.x ${x} --positionMm.y 0 --positionMm.z 40`, seq);
  }
  await expectDrawn(page, ['entity-1', 'entity-2', 'entity-3']);
  await page.keyboard.press('Backquote'); // close the console

  // The default framing: a few pixels between neighbouring terminals, so hovering offers the zoom.
  const pitch = await pitchOf(page, 1);
  expect(pitch).not.toBeNull();
  expect(pitch as number).toBeLessThan(24);
  await page.evaluate((spool) => {
    const w = window as unknown as Win;
    w.__routingEvents = [];
    w.__controlsViewport?.onRouting((e) => w.__routingEvents?.push(e));
    w.__controlsViewport?.setRouting({ ...spool, from: null, waypoints: [] });
  }, SPOOL);
  const far = await terminalOnPage(page, { entity: 1, terminal: 'a' });
  await page.mouse.move(far.x, far.y + 3);
  await idle(page);
  await expect
    .poll(async () => {
      const v = await terminalView(page);
      return v && { device: v.device, zoom: v.zoomSuggested };
    })
    .toStrictEqual({ device: 1, zoom: true });

  // view.focus on the block: at least 24 px (or ample), and a click near terminal a is a pick.
  expect(await page.evaluate(() => (window as unknown as Win).__controlsViewport?.focus('entity-1'))).toBe(true);
  await idle(page);
  const zoomed = await pitchOf(page, 1);
  expect(zoomed === null || zoomed >= 24).toBe(true);
  const a = await terminalOnPage(page, { entity: 1, terminal: 'a' });
  await page.mouse.move(a.x + 4, a.y);
  await idle(page);
  await expect.poll(async () => (await terminalView(page))?.hit ?? null).toStrictEqual({ entity: 1, terminal: 'a' });
  expect(await markers(page)).toStrictEqual(['pick']);
  await page.mouse.click(a.x + 4, a.y);
  await expect
    .poll(() => routingEvents(page))
    .toStrictEqual([{ kind: 'terminal', end: { entity: 1, terminal: 'a' }, source: 'pointer', proposal: null }]);

  // The UI folds it into the session; Tab to block 3's terminal a, Enter picks it with the proposal.
  await page.evaluate((spool) => {
    (window as unknown as Win).__controlsViewport?.setRouting({
      ...spool,
      from: { entity: 1, terminal: 'a', termination: 'auto' },
      waypoints: [],
    });
  }, SPOOL);
  expect(await page.evaluate(() => (window as unknown as Win).__controlsViewport?.select('entity-3'))).toBe(true);
  expect(await page.evaluate(() => (window as unknown as Win).__controlsViewport?.cycleTerminal(1))).toStrictEqual({
    entity: 3,
    terminal: 'a',
  });
  await page.locator('ctl-viewport canvas').focus();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await routingEvents(page)).length).toBe(2);
  const picked = (await routingEvents(page))[1];
  expect(picked).toMatchObject({ kind: 'terminal', source: 'keyboard', end: { entity: 3, terminal: 'a' } });
  // Direct along the blocks' top faces (12 mm, no duct here), plus 5 % slack rounded up: 13 mm.
  expect(picked).toMatchObject({ proposal: { ok: true, lengthMm: 13, floorMm: 12 } });
  // Escape while routing is the UI's: one cancel event.
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await routingEvents(page)).at(-1)).toStrictEqual({ kind: 'cancel' });
  await page.evaluate(() => (window as unknown as Win).__controlsViewport?.setRouting(null));
  await idle(page);
  expect(await markers(page)).toStrictEqual([]);
  expect(errors).toStrictEqual([]);
});

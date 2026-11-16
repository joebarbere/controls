import { expect, type Page } from '@playwright/test';

/*
 * Aiming the real mouse at something the renderer projects (F3.2 part 3). A projected point can fall
 * under a viewport overlay (the HUD, the sim controls, the belt bar), and then a real click hits the
 * overlay, not the canvas. Every aim checks `document.elementFromPoint` first, and a failure names
 * what covers the point, so a CI log says which overlay it was.
 */

type TerminalRef = { entity: number; terminal: string };
type Hook = {
  whenIdle(): Promise<void>;
  projectTerminal(ref: TerminalRef): { x: number; y: number } | null;
};

/** Expects the page point (`x`, `y`) to be on the viewport canvas, not under an overlay. */
export async function expectOnCanvas(page: Page, at: { x: number; y: number }, what: string): Promise<void> {
  const over = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    if (el.tagName === 'CANVAS') return 'CANVAS';
    const named = el.closest('[data-testid], [aria-label]');
    return `${el.tagName} in ${named?.getAttribute('data-testid') ?? named?.getAttribute('aria-label') ?? '?'}`;
  }, at);
  expect(over, `${what} is under an overlay`).toBe('CANVAS');
}

/**
 * The page position of a terminal's entry point, offset by (`dx`, `dy`) CSS px, after the renderer is
 * idle, checked to be on the canvas.
 */
export async function terminalOnPage(page: Page, ref: TerminalRef, dx = 0, dy = 0): Promise<{ x: number; y: number }> {
  await page.evaluate(() => (window as unknown as { __controlsViewport?: Hook }).__controlsViewport?.whenIdle());
  const box = await page.locator('ctl-viewport canvas').boundingBox();
  const p = await page.evaluate(
    (r) => (window as unknown as { __controlsViewport?: Hook }).__controlsViewport?.projectTerminal(r) ?? null,
    ref,
  );
  if (!box || !p) throw new Error('terminal not on the canvas');
  const at = { x: box.x + p.x + dx, y: box.y + p.y + dy };
  await expectOnCanvas(page, at, `terminal ${ref.entity}/${ref.terminal}`);
  return at;
}

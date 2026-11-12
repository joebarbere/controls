import { expect, type Page } from '@playwright/test';

/*
 * Console-driven setup that the renderer hook can rely on.
 *
 * A console line runs its command synchronously in the Enter keydown, so the session's world signal
 * has changed when `keyboard.press` returns. The viewport draws that world from an Angular effect,
 * which runs at the next change detection: zoneless Angular schedules it as a task (a setTimeout and
 * animation-frame race), and a busy main thread (software WebGL2 on a CI runner) can run several
 * protocol round trips first. Until then `__controlsViewport.select('entity-2')` returns false: the
 * renderer has not drawn entity 2 yet. Seen on a macOS runner (PR #80), where the old setup loop's
 * `toHaveText(/: ok/)` matched the previous line's output and so never waited for a render at all.
 */

/**
 * Types `line` into the focused console input and waits for its own result, `<id>: ok (log #seq)`.
 * Matching on the log number, not on `: ok`, is what makes this wait: the previous line's output is
 * also `…: ok`, so a bare `/: ok/` passes before this line's output (and the render with it) exists.
 */
export async function runLogged(page: Page, line: string, seq: number): Promise<void> {
  await page.keyboard.insertText(line);
  await page.keyboard.press('Enter');
  const id = line.split(' ')[0];
  await expect(page.getByTestId('console-output').locator('.entry').last()).toHaveText(`${id}: ok (log #${seq})`);
}

/**
 * Waits until the renderer has drawn the world's entities `ids` (`entity-<n>`), so the `?e2e=1` hook can
 * select, pick or read them. Wait on this, never on time, before driving the hook after a command.
 */
export async function expectDrawn(page: Page, ids: readonly string[]): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const hook = (window as unknown as { __controlsViewport?: { selectables(): ReadonlyArray<{ id: string }> } })
          .__controlsViewport;
        return hook?.selectables().map((s) => s.id) ?? [];
      }),
    )
    .toEqual(expect.arrayContaining([...ids]));
}

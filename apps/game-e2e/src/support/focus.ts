import { expect, type Locator, type Page } from '@playwright/test';

/*
 * Keyboard-focus assertions for the F1.1 acceptance (mouse-free, focus always visible).
 *
 * Every protocol round trip waits for the page's main thread, which is busy whenever the 3D viewport
 * draws a frame (SwiftShader WebGL2: around 100-200 ms a frame locally, slower on CI runners; it
 * draws on demand, so mostly while the pointer or a held key changes the view). `locator.evaluate`
 * costs several round trips (resolve the selector to a handle, evaluate, release the handle), about
 * five times an `expect(locator)` matcher or a `page.evaluate`. These helpers avoid it: one matcher
 * for identity, then one `page.evaluate` on `document.activeElement`.
 */

/** The element has keyboard focus and a visible focus indicator (:focus-visible with an outline of at least 2 px). */
export async function expectVisibleFocus(page: Page, locator: Locator): Promise<void> {
  await expect(locator).toBeFocused();
  // No input since the matcher passed, so the active element is still `locator`'s element.
  const indicator = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return { focusVisible: false, outline: 0 };
    const style = getComputedStyle(el);
    return {
      focusVisible: el.matches(':focus-visible'),
      outline: style.outlineStyle === 'none' ? 0 : parseFloat(style.outlineWidth),
    };
  });
  expect(indicator.focusVisible, 'focused element matches :focus-visible').toBe(true);
  expect(indicator.outline, 'focus outline width (px)').toBeGreaterThanOrEqual(2);
}

/** Presses `key` (Tab by default) until `target` has focus, at most `maxPresses` times. */
export async function tabTo(page: Page, target: Locator, maxPresses = 15, key = 'Tab'): Promise<void> {
  // Resolve the target once; each check is then a single round trip.
  const handle = await target.elementHandle();
  try {
    for (let i = 0; i < maxPresses; i++) {
      if (await page.evaluate((el) => el === document.activeElement, handle)) return;
      await page.keyboard.press(key);
    }
  } finally {
    await handle?.dispose();
  }
  await expect(target).toBeFocused();
}

import { expect, test } from '@playwright/test';
import { launchControls } from './launch';

// One launch per file (docs/caveats/release.md), so this also runs against a packaged build.
test('Quit in the main menu ends the app through app:quit', async () => {
  const app = await launchControls();
  try {
    const closed = app.window.waitForEvent('close', { timeout: 20_000 });
    const quit = app.window.getByRole('navigation', { name: 'Controls' }).getByRole('button', { name: 'Quit' });
    await quit.focus();
    // The app can exit between keydown and keyup, which rejects the press itself: that's success.
    await app.window.keyboard.press('Enter').catch(() => undefined);
    await closed;
    expect(app.window.isClosed()).toBe(true);
  } finally {
    await app.close().catch(() => undefined); // already gone
  }
});

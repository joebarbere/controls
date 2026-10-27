import { expect, test } from '@playwright/test';

// Browser dev harness (`pnpm start:web`): same Angular app, WebPlatform instead of the Electron bridge.
test('boots the game shell with the web platform', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Controls');
  await expect(page.getByRole('heading', { name: 'Controls' })).toBeVisible();
  await expect(page.getByTestId('about-platform')).toHaveText('web harness');
  await expect(page.getByTestId('about-isolated')).toHaveText('yes'); // dev server sends COOP/COEP too
});

test('3D viewport starts (WebGPU or WebGL2 fallback)', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('ctl-viewport')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  await expect(page.getByTestId('about-backend')).toHaveText(/^(webgpu|webgl2)$/);
});

test('viewport draws a scene, not a blank canvas', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  const viewport = page.locator('ctl-viewport');
  await expect(viewport).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  await page.waitForTimeout(500); // let a few frames land
  // A uniformly filled 1280×720 PNG compresses to a few KB; the shaded panel + rails is far larger.
  const png = await viewport.screenshot();
  expect(png.byteLength).toBeGreaterThan(20_000);
});

test('WebGL2 fallback path stays working when forced', async ({ page }) => {
  await page.goto('/?renderer=webgl2');
  await expect(page.locator('ctl-viewport')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  await expect(page.getByTestId('about-backend')).toHaveText('webgl2');
});

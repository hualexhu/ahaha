import { expect, test, type Page } from '@playwright/test';
import { afterRender, exportFile, magic, probe, upload } from './helpers';

/**
 * Cross-browser behaviour, simulated in Chromium by patching the processing
 * worker's globals before its code runs (the worker script is intercepted
 * and the patch prepended).
 */
async function patchWorker(page: Page, patch: string): Promise<void> {
  await page.route(/processor\.worker[^/]*\.(js|ts)/, async (route) => {
    const res = await route.fetch();
    const body = await res.text();
    await route.fulfill({ response: res, body: `${patch}\n${body}` });
  });
}

// Safari: canvas.convertToBlob({type:'image/webp'}) silently returns a PNG
const SAFARI_NO_WEBP = `
const __convert = OffscreenCanvas.prototype.convertToBlob;
OffscreenCanvas.prototype.convertToBlob = function (o) {
  return __convert.call(this, o && o.type === 'image/webp' ? { type: 'image/png' } : o);
};`;

// Older engines: createImageBitmap ignores the resize options
const NO_RESIZE_OPTIONS = `
const __cib = self.createImageBitmap.bind(self);
self.createImageBitmap = (src) => __cib(src);`;

test('WebP export still produces a real WebP where the canvas cannot encode it (Safari)', async ({ page }) => {
  await patchWorker(page, SAFARI_NO_WEBP);
  await page.goto('/');
  await upload(page, ['scene.png']);
  await page.getByTestId('fmt-webp').click();
  const { path, name } = await exportFile(page);
  expect(name).toMatch(/\.webp$/);
  // RIFF....WEBP
  const m = magic(path);
  expect(m.slice(0, 8)).toBe('52494646');
  expect(m.slice(16, 24)).toBe('57454250');
  const info = probe(path);
  expect(info.codec).toBe('webp');
  expect([info.width, info.height]).toEqual([960, 640]);
});

test('preview is scaled, not cropped, where createImageBitmap ignores resize options', async ({ page }) => {
  await patchWorker(page, NO_RESIZE_OPTIONS);
  await page.goto('/');
  await upload(page, ['scene.png']);
  // turn every effect off so the preview shows the decoded source
  for (const t of ['colour', 'databend', 'palette']) {
    await afterRender(page, () => page.locator(`[data-enable="${t}"]`).uncheck());
  }
  const px = await page.evaluate(() => {
    const c = document.querySelector('.frame canvas') as HTMLCanvasElement;
    const d = c.getContext('2d')!.getImageData(c.width - 4, c.height - 4, 1, 1).data;
    return { w: c.width, h: c.height, rgb: [d[0], d[1], d[2]] };
  });
  expect([px.w, px.h]).toEqual([720, 480]);
  // the scene's bottom-right corner is the black colour bar; a crop would show the green hill
  expect(Math.max(...px.rgb)).toBeLessThan(40);
});

test('browsers without OffscreenCanvas get a clear message instead of a broken app', async ({ page }) => {
  await page.addInitScript(() => {
    // @ts-expect-error simulate an old browser
    delete window.OffscreenCanvas;
  });
  await page.goto('/');
  await expect(page.getByTestId('unsupported')).toContainText('OffscreenCanvas');
  await expect(page.getByRole('button', { name: 'Choose files' })).toBeDisabled();
});

// iOS Safari: canvases above its pixel budget are refused (getContext → null)
const CANVAS_LIMIT_400K = `
const __getContext = OffscreenCanvas.prototype.getContext;
OffscreenCanvas.prototype.getContext = function (...a) {
  return this.width * this.height > 400000 ? null : __getContext.apply(this, a);
};`;

test('images larger than the browser canvas limit are scaled to fit, with a note (iOS Safari)', async ({ page }) => {
  await patchWorker(page, CANVAS_LIMIT_400K);
  await page.goto('/');
  await upload(page, ['scene.png']); // 960×640 = 614k px, over the simulated limit
  await page.getByTestId('fmt-png').click();
  const { path } = await exportFile(page);
  const info = probe(path);
  expect(info.width * info.height).toBeLessThanOrEqual(400_000);
  expect(info.width / info.height).toBeCloseTo(1.5, 1);
  await expect(page.getByTestId('message')).toContainText('Scaled to');
});

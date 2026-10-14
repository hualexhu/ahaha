import { expect, test } from '@playwright/test';
import { statSync } from 'node:fs';
import { BUILTIN_PRESETS } from '../src/core/presets';
import { afterRender, exportFile, magic, probe, upload } from './helpers';

test.describe('image workflow', () => {
  test('each built-in preset renders and exports valid PNG / JPEG / WebP', async ({ page }) => {
    await page.goto('/');
    await upload(page, ['scene.png']);
    for (const preset of BUILTIN_PRESETS) {
      await afterRender(page, () => page.getByTestId('preset-select').selectOption(preset.name));
      await expect(page.getByTestId('preset-select')).toHaveValue(preset.name);
      const slug = preset.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      await page.screenshot({ path: `screenshots/preset-${slug}.png` });
      for (const [format, ext, sig, codec] of [
        ['png', 'png', '89504e47', 'png'],
        ['jpeg', 'jpg', 'ffd8ff', 'mjpeg'],
        ['webp', 'webp', '52494646', 'webp'],
      ] as const) {
        await page.getByTestId(`fmt-${format}`).click();
        const { path, name } = await exportFile(page);
        expect(name).toBe(`scene_glitchlab_${slug}_${preset.pipeline.seed}.${ext}`);
        expect(statSync(path).size).toBeGreaterThan(1000);
        expect(magic(path).startsWith(sig)).toBe(true);
        const info = probe(path);
        expect(info.codec).toBe(codec);
        expect(info.width).toBeGreaterThan(0);
        expect(info.height).toBeGreaterThan(0);
        if (preset.name !== 'Light Trails') {
          // no geometry change in the presets: full-res export keeps the original size
          expect([info.width, info.height]).toEqual([960, 640]);
        }
      }
    }
  });

  test('raw glitched JPEG and ASCII text export', async ({ page }) => {
    await page.goto('/');
    await upload(page, ['scene.jpg']);
    await afterRender(page, () => page.getByTestId('preset-select').selectOption('Heavy Glitch'));
    await page.getByTestId('fmt-jpeg-raw').click();
    const raw = await exportFile(page);
    expect(raw.name).toMatch(/_glitchlab_heavy-glitch_9001\.jpg$/);
    expect(magic(raw.path).startsWith('ffd8')).toBe(true);
    expect(probe(raw.path).width).toBe(960);

    await afterRender(page, () => page.getByTestId('preset-select').selectOption('Terminal ASCII'));
    const txt = await exportFile(page, 'export-txt');
    expect(txt.name).toMatch(/\.txt$/);
    const { readFileSync } = await import('node:fs');
    const lines = readFileSync(txt.path, 'utf8').trimEnd().split('\n');
    expect(lines.length).toBeGreaterThan(20);
    expect(lines[0].length).toBeGreaterThan(50);
  });
});

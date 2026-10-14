import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unzipSync } from 'fflate';
import { afterRender, exportFile, probe, upload } from './helpers';

test('presets: save, reload from localStorage, delete, JSON export + import', async ({ page }) => {
  await page.goto('/');
  await upload(page, ['scene.png']);
  const select = page.getByTestId('preset-select');

  // tweak a parameter → preset becomes "custom"
  await afterRender(page, () => select.selectOption('8-bit Arcade'));
  await page.locator('[data-effect="eightbit"] .title').click();
  await afterRender(page, () => page.locator('[data-effect="eightbit"] input[data-param="block"]').fill('16'));
  await expect(select).toHaveValue('');

  // save
  await page.getByRole('button', { name: 'Preset options' }).click();
  await page.getByLabel('New preset name').fill('Chunky');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(select).toHaveValue('Chunky');

  // survives a reload
  await page.reload();
  await expect(page.locator('option', { hasText: 'Chunky' })).toHaveCount(1);
  await upload(page, ['scene.png']);
  await afterRender(page, () => select.selectOption('Chunky'));
  await page.locator('[data-effect="eightbit"] .title').click();
  await expect(page.locator('[data-effect="eightbit"] input[data-param="block"]')).toHaveValue('16');

  // export JSON
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Preset options' }).click();
  await page.getByRole('button', { name: 'Export JSON' }).click();
  const presetFile = await (await dl).path();
  const parsed = JSON.parse(readFileSync(presetFile, 'utf8'));
  expect(parsed.presets.map((p: { name: string }) => p.name)).toContain('Chunky');

  // delete
  await page.getByRole('button', { name: 'Preset options' }).click();
  await page.getByRole('button', { name: /^Delete/ }).click();
  await expect(page.locator('option', { hasText: 'Chunky' })).toHaveCount(0);

  // import (renamed copy)
  parsed.presets[0].name = 'Imported Chunky';
  const f = join(tmpdir(), `gl-presets-${Date.now()}.json`);
  writeFileSync(f, JSON.stringify(parsed));
  await page.getByTestId('preset-import').setInputFiles(f);
  await expect(page.getByTestId('message')).toContainText('Imported 1 preset');
  await afterRender(page, () => select.selectOption('Imported Chunky'));
  await expect(select).toHaveValue('Imported Chunky');
});

test('batch: applies the pipeline to 3 files and downloads a ZIP', async ({ page }) => {
  await page.goto('/');
  await upload(page, ['scene.png', 'gradient.webp', 'scene.jpg']);
  await expect(page.getByTestId('thumb')).toHaveCount(3);
  await expect(page.getByTestId('export-batch')).toContainText('(3)');
  await afterRender(page, () => page.getByTestId('preset-select').selectOption('Noir Sort'));
  await page.getByTestId('fmt-png').click();
  const { path, name } = await exportFile(page, 'export-batch');
  expect(name).toBe('glitchlab_batch_noir-sort_1947.zip');
  const entries = unzipSync(new Uint8Array(readFileSync(path)));
  const names = Object.keys(entries).sort();
  expect(names).toEqual([
    'gradient_glitchlab_noir-sort_1947.png',
    'scene_glitchlab_noir-sort_1947-2.png',
    'scene_glitchlab_noir-sort_1947.png',
  ]);
  const dir = join(tmpdir(), `gl-batch-${Date.now()}`);
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dir);
  for (const n of names) {
    expect(entries[n].length).toBeGreaterThan(1000);
    writeFileSync(join(dir, n), entries[n]);
    const info = probe(join(dir, n));
    expect(info.codec).toBe('png');
  }
  expect(probe(join(dir, 'gradient_glitchlab_noir-sort_1947.png')).width).toBe(640);
});

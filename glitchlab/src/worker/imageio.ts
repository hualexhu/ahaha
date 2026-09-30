/// <reference lib="webworker" />
import { fitLongEdge, type Img } from '../core/image';
import type { GlyphAtlas } from '../effects/types';

/** Decode an image file (JPEG/PNG/WebP...) to RGBA, optionally downscaled to a long-edge limit. */
export async function decodeImageFile(file: Blob, maxEdge?: number): Promise<Img> {
  const probe = await createImageBitmap(file);
  let { width, height } = probe;
  let bmp = probe;
  if (maxEdge && Math.max(width, height) > maxEdge) {
    ({ width, height } = fitLongEdge(width, height, maxEdge));
    bmp = await createImageBitmap(file, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
    probe.close();
  }
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const id = ctx.getImageData(0, 0, width, height);
  return { width, height, data: id.data };
}

export function imgToImageData(img: Img): ImageData {
  // copy into a buffer owned by ImageData
  return new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
}

export function imgToBitmap(img: Img): ImageBitmap {
  const canvas = new OffscreenCanvas(img.width, img.height);
  canvas.getContext('2d')!.putImageData(imgToImageData(img), 0, 0);
  return canvas.transferToImageBitmap();
}

export type ImageFormat = 'png' | 'jpeg' | 'webp';

export async function encodeImage(img: Img, format: ImageFormat, quality = 0.92): Promise<Blob> {
  const canvas = new OffscreenCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d')!;
  if (format === 'jpeg') {
    // JPEG has no alpha: composite on black like the preview does
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, img.width, img.height);
    const tmp = new OffscreenCanvas(img.width, img.height);
    tmp.getContext('2d')!.putImageData(imgToImageData(img), 0, 0);
    ctx.drawImage(tmp, 0, 0);
  } else ctx.putImageData(imgToImageData(img), 0, 0);
  return canvas.convertToBlob({ type: `image/${format}`, quality });
}

const glyphCache = new Map<string, GlyphAtlas>();

/** Rasterise characters with the platform monospace font into coverage masks. */
export function canvasGlyphs(chars: string[], cellW: number, cellH: number): GlyphAtlas {
  const key = `${cellW}x${cellH}:${chars.join('\u0000')}`;
  const hit = glyphCache.get(key);
  if (hit) return hit;
  const canvas = new OffscreenCanvas(cellW, cellH);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const masks = chars.map((ch) => {
    ctx.clearRect(0, 0, cellW, cellH);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${Math.round(cellH * 0.92)}px "DejaVu Sans Mono", "Menlo", "Consolas", monospace`;
    // block elements should fill the whole cell
    if (/[░▒▓█]/.test(ch)) {
      const density = { '░': 0.25, '▒': 0.5, '▓': 0.75, '█': 1 }[ch] ?? 1;
      const m = new Float32Array(cellW * cellH);
      for (let y = 0; y < cellH; y++) for (let x = 0; x < cellW; x++) {
        // patterned fill so shades look like the CP437 glyphs
        const on = density >= 1 || ((x * 7 + y * 13) % 4) / 4 < density;
        m[y * cellW + x] = on ? 1 : 0;
      }
      return m;
    }
    ctx.fillText(ch, cellW / 2, cellH / 2 + 1);
    const d = ctx.getImageData(0, 0, cellW, cellH).data;
    const m = new Float32Array(cellW * cellH);
    for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3] / 255;
    return m;
  });
  const atlas = { cellW, cellH, masks };
  if (glyphCache.size > 32) glyphCache.clear();
  glyphCache.set(key, atlas);
  return atlas;
}

/// <reference lib="webworker" />
import { fitLongEdge, type Img } from '../core/image';
import type { GlyphAtlas } from '../effects/types';

/** A 2D context or a clear error (OffscreenCanvas without 2D: Safari < 16.4). */
export function ctx2d(canvas: OffscreenCanvas, opts?: CanvasRenderingContext2DSettings): OffscreenCanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', opts);
  if (!ctx) throw new Error('This browser cannot draw in a background worker (OffscreenCanvas 2D). Please update it, or use a recent Chrome, Edge, Firefox or Safari 16.4+.');
  return ctx;
}

export interface DecodedImage {
  img: Img;
  /** Size of the file's image before any downscaling. */
  sourceWidth: number;
  sourceHeight: number;
  /** Set when the image had to be scaled down to fit the browser's canvas limits. */
  note?: string;
}

/**
 * iOS Safari refuses canvases above ~16.7 MP (4096²) while a recent iPhone
 * shoots 24 MP. When a full-size canvas is refused, decode at this budget
 * instead (halving further if that is refused too).
 */
export const SAFE_CANVAS_PIXELS = 16_000_000;

function tryCanvas(w: number, h: number): { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } | null {
  try {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    return ctx ? { canvas, ctx } : null;
  } catch {
    return null;
  }
}

/**
 * Decode an image file (JPEG/PNG/WebP...) to RGBA, optionally downscaled to a
 * long-edge limit. Asks the browser to resize during decode where it can, but
 * always draws at the target size, so a browser that ignores the resize
 * options still gets a correctly scaled (not cropped) result.
 */
export async function decodeImageFile(file: Blob, maxEdge?: number): Promise<DecodedImage> {
  const full = await createImageBitmap(file);
  const sourceWidth = full.width;
  const sourceHeight = full.height;
  let { width, height } = full;
  if (maxEdge && Math.max(width, height) > maxEdge) ({ width, height } = fitLongEdge(width, height, maxEdge));
  let target = tryCanvas(width, height);
  let note: string | undefined;
  // refused (canvas size limit): retry at ≤ 16 MP, then keep halving the area
  const w0 = width, h0 = height;
  let budget = Math.min(SAFE_CANVAS_PIXELS, Math.floor(w0 * h0 * 0.99));
  while (!target && budget >= 65_536) {
    const s = Math.sqrt(budget / (w0 * h0));
    width = Math.max(1, Math.floor(w0 * s));
    height = Math.max(1, Math.floor(h0 * s));
    target = tryCanvas(width, height);
    if (target) note = `Scaled to ${width}×${height}: this browser can't hold a ${w0}×${h0} image in a canvas.`;
    budget = Math.floor(budget / 2);
  }
  if (!target) {
    full.close();
    throw new Error('This browser cannot draw in a background worker (OffscreenCanvas 2D). Please update it, or use a recent Chrome, Edge, Firefox or Safari 16.4+.');
  }
  let bmp: ImageBitmap = full;
  if (width !== sourceWidth || height !== sourceHeight) {
    try {
      bmp = await createImageBitmap(file, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
    } catch {
      bmp = full; // resize options unsupported: scale while drawing instead
    }
  }
  const { ctx } = target;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, width, height);
  bmp.close();
  if (bmp !== full) full.close();
  const id = ctx.getImageData(0, 0, width, height);
  return { img: { width, height, data: id.data }, sourceWidth, sourceHeight, note };
}

export function imgToImageData(img: Img): ImageData {
  // copy into a buffer owned by ImageData
  return new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
}

export function imgToBitmap(img: Img): ImageBitmap {
  const canvas = new OffscreenCanvas(img.width, img.height);
  ctx2d(canvas).putImageData(imgToImageData(img), 0, 0);
  return canvas.transferToImageBitmap();
}

export type ImageFormat = 'png' | 'jpeg' | 'webp';

/** The MIME type a canvas actually produced matches the one we asked for. */
export const encodedAs = (blob: Blob, format: ImageFormat): boolean => blob.type === `image/${format}`;

/**
 * Encode with the browser's canvas encoder. Safari cannot encode WebP from a
 * canvas and silently returns PNG instead, so the result type is checked and
 * WebP falls back to the libwebp encoder inside ffmpeg.wasm.
 */
export async function encodeImage(img: Img, format: ImageFormat, quality = 0.92): Promise<Blob> {
  const canvas = new OffscreenCanvas(img.width, img.height);
  const ctx = ctx2d(canvas);
  if (format === 'jpeg') {
    // JPEG has no alpha: composite on black like the preview does
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, img.width, img.height);
    const tmp = new OffscreenCanvas(img.width, img.height);
    ctx2d(tmp).putImageData(imgToImageData(img), 0, 0);
    ctx.drawImage(tmp, 0, 0);
  } else ctx.putImageData(imgToImageData(img), 0, 0);
  const blob = await canvas.convertToBlob({ type: `image/${format}`, quality });
  if (encodedAs(blob, format)) return blob;
  if (format === 'webp') {
    const { encodeWebp } = await import('./webp');
    return encodeWebp(img, quality);
  }
  throw new Error(`This browser cannot encode ${format.toUpperCase()} images.`);
}

const glyphCache = new Map<string, GlyphAtlas>();

/** Rasterise characters with the platform monospace font into coverage masks. */
export function canvasGlyphs(chars: string[], cellW: number, cellH: number): GlyphAtlas {
  const key = `${cellW}x${cellH}:${chars.join('\u0000')}`;
  const hit = glyphCache.get(key);
  if (hit) return hit;
  const canvas = new OffscreenCanvas(cellW, cellH);
  const ctx = ctx2d(canvas, { willReadFrequently: true });
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

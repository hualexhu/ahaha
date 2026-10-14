import { it } from 'vitest';
import { createImg } from '../../src/core/image';
import { defaultPipeline, runPipeline } from '../../src/core/pipeline';
import { EFFECTS } from '../../src/effects';
import { encodeJpeg } from '../../src/codec/jpegEncoder';
import { decodeJpeg } from '../../src/codec/jpegDecoder';

/** Dev tool: times every effect and the full pipeline on a synthetic 12 MP frame. */
it('12 MP timings', () => {
  const W = 4000, H = 3000;
  const img = createImg(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    img.data[i] = (x * 255) / W; img.data[i + 1] = (y * 255) / H; img.data[i + 2] = ((x ^ y) & 255); img.data[i + 3] = 255;
  }
  const lines: string[] = [];
  const time = (label: string, fn: () => unknown) => { const t = performance.now(); fn(); lines.push(`${label}: ${Math.round(performance.now() - t)} ms`); };
  let jpg: Uint8Array = new Uint8Array();
  time('jpeg encode q60', () => { jpg = encodeJpeg(img, { quality: 60 }); });
  time('jpeg decode', () => decodeJpeg(jpg));
  for (const type of Object.keys(EFFECTS)) {
    const p = defaultPipeline();
    p.effects.forEach((e) => { e.enabled = e.type === type; });
    const inst = p.effects.find((e) => e.type === type)!;
    if (type === 'databend') Object.assign(inst.params, { dhtOn: true, chromaOn: true, zigzagOn: true });
    if (type === 'geometry') Object.assign(inst.params, { aspect: '4:5', rotate: '90' });
    if (type === 'colour') Object.assign(inst.params, { exposure: 0.5, hue: 30, saturation: 0.2, sepia: true });
    if (type === 'eightbit') Object.assign(inst.params, { dither: 'floyd' });
    if (type === 'palette') Object.assign(inst.params, { dither: 'floyd' });
    time(type, () => runPipeline(img, p, { isVideo: true }));
  }
  const all = defaultPipeline();
  all.effects.forEach((e) => { e.enabled = e.type !== 'datamosh'; });
  time('FULL pipeline (all still effects)', () => runPipeline(img, all));
  console.log(lines.join('\n'));
});

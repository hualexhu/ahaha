import { cloneImg, type Img } from '../core/image';
import { mixParam, num, type EffectDef, type Params } from './types';
import { applyMix } from '../core/image';

/**
 * Datamosh-lite. Real datamoshing drops I-frames so the codec keeps applying
 * motion vectors and residuals to a stale picture. We imitate that:
 *  - every `hold` frames a "keyframe" is taken from the real frame;
 *  - in between, block motion between the previous and current source frame
 *    is estimated (coarse block matching on a downscaled luma plane) and the
 *    blocks of the held picture are moved by those vectors, plus a share of
 *    the frame-to-frame residual;
 *  - the glitch amount ramps from `rampFrom` to `rampTo` across each hold, so
 *    the picture drifts further away from reality the longer it is held.
 */

interface MoshState {
  moshed?: Img;
  prev?: Img;
  prevLuma?: Float32Array;
  lw?: number;
  lh?: number;
}

const DS = 4; // luma downscale factor for motion search

function lumaPlane(img: Img): { l: Float32Array; w: number; h: number } {
  const w = Math.max(1, Math.floor(img.width / DS));
  const h = Math.max(1, Math.floor(img.height / DS));
  const l = new Float32Array(w * h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((y * DS) * img.width + x * DS) * 4;
      l[y * w + x] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    }
  }
  return { l, w, h };
}

export function applyDatamosh(img: Img, p: Params, frameIndex: number, st: MoshState): Img {
  const hold = Math.max(1, Math.round(num(p, 'hold', 30)));
  const block = Math.max(4, Math.round(num(p, 'block', 16)));
  const strength = num(p, 'strength', 1);
  const residual = num(p, 'residual', 0.15);
  const rampFrom = num(p, 'rampFrom', 0.2);
  const rampTo = num(p, 'rampTo', 1);
  const pos = frameIndex % hold;
  const cur = lumaPlane(img);
  const sameSize = st.moshed && st.moshed.width === img.width && st.moshed.height === img.height;

  if (pos === 0 || !sameSize || !st.prevLuma || st.lw !== cur.w || st.lh !== cur.h) {
    st.moshed = cloneImg(img);
    st.prev = img;
    st.prevLuma = cur.l;
    st.lw = cur.w;
    st.lh = cur.h;
    return cloneImg(img);
  }

  const amount = rampFrom + (rampTo - rampFrom) * (hold > 1 ? pos / (hold - 1) : 1);
  const W = img.width, H = img.height;
  const moshed = st.moshed!;
  const next = cloneImg(moshed);
  const src = new Uint32Array(moshed.data.buffer);
  const dst = new Uint32Array(next.data.buffer);
  const pl = st.prevLuma, cl = cur.l, lw = cur.w, lh = cur.h;
  const lb = Math.max(1, Math.round(block / DS));
  const range = 3; // ±3 downscaled px = ±12 px
  for (let by = 0; by < H; by += block) {
    for (let bx = 0; bx < W; bx += block) {
      const lx = Math.floor(bx / DS), ly = Math.floor(by / DS);
      // find where this block came from in the previous frame
      let best = Infinity, mvx = 0, mvy = 0;
      for (let dy = -range; dy <= range; dy++) {
        for (let dx = -range; dx <= range; dx++) {
          let sad = 0;
          for (let y = 0; y < lb; y++) {
            const cy = Math.min(lh - 1, ly + y), py = Math.min(lh - 1, Math.max(0, ly + y + dy));
            for (let x = 0; x < lb; x++) {
              const cx = Math.min(lw - 1, lx + x), px = Math.min(lw - 1, Math.max(0, lx + x + dx));
              sad += Math.abs(cl[cy * lw + cx] - pl[py * lw + px]);
            }
          }
          // slight bias towards zero motion to avoid jitter on flat areas
          sad += (Math.abs(dx) + Math.abs(dy)) * lb;
          if (sad < best) { best = sad; mvx = dx; mvy = dy; }
        }
      }
      const sx = Math.round(mvx * DS * strength), sy = Math.round(mvy * DS * strength);
      for (let y = by; y < Math.min(H, by + block); y++) {
        const yy = Math.min(H - 1, Math.max(0, y + sy));
        for (let x = bx; x < Math.min(W, bx + block); x++) {
          const xx = Math.min(W - 1, Math.max(0, x + sx));
          dst[y * W + x] = src[yy * W + xx];
        }
      }
    }
  }
  // add a share of the real frame-to-frame change (the "residual")
  if (residual > 0 && st.prev) {
    const nd = next.data, cd = img.data, pd = st.prev.data;
    for (let i = 0; i < nd.length; i += 4) {
      nd[i] += (cd[i] - pd[i]) * residual;
      nd[i + 1] += (cd[i + 1] - pd[i + 1]) * residual;
      nd[i + 2] += (cd[i + 2] - pd[i + 2]) * residual;
    }
  }
  st.moshed = next;
  st.prev = img;
  st.prevLuma = cur.l;
  // output: blend real frame -> moshed by the ramped amount
  return applyMix(img, cloneImg(next), Math.max(0, Math.min(1, amount)));
}

export const datamoshEffect: EffectDef = {
  type: 'datamosh',
  label: 'Datamosh-lite',
  description: 'Video only: hold a keyframe and push its blocks around with the motion of later frames.',
  videoOnly: true,
  params: [
    { kind: 'range', key: 'hold', label: 'Keyframe every', min: 1, max: 240, step: 1, default: 30, int: true, unit: 'frames' },
    { kind: 'range', key: 'block', label: 'Block size', min: 8, max: 64, step: 4, default: 16, int: true, pixels: true, unit: 'px' },
    { kind: 'range', key: 'strength', label: 'Motion strength', min: 0, max: 3, step: 0.05, default: 1 },
    { kind: 'range', key: 'residual', label: 'Residual', min: 0, max: 1, step: 0.01, default: 0.15 },
    { kind: 'range', key: 'rampFrom', label: 'Glitch ramp start', min: 0, max: 1, step: 0.01, default: 0.2 },
    { kind: 'range', key: 'rampTo', label: 'Glitch ramp end', min: 0, max: 1, step: 0.01, default: 1 },
    mixParam,
  ],
  apply: (img, p, _rng, ctx) => {
    if (!ctx.isVideo) return img;
    const out = applyDatamosh(img, p, ctx.frameIndex, ctx.state as MoshState);
    return applyMix(img, out, num(p, 'mix', 1));
  },
};

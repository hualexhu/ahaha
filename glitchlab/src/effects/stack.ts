import { createImg, type Img } from '../core/image';

/**
 * Long exposure / frame stacking. Frames are combined with `average`,
 * `lighten` (per-channel max → light trails) or `darken` (per-channel min).
 *
 *  - `RollingStack` keeps the last N frames and emits the combination for
 *    every new frame (rolling-window video).
 *  - `StillStack` folds every frame of a clip into one picture using O(1)
 *    memory per pixel (for the "single still" output).
 */

export type StackMode = 'average' | 'lighten' | 'darken';

export class StillStack {
  private sum: Float64Array | null = null;
  private acc: Uint8ClampedArray | null = null;
  private count = 0;
  private w = 0;
  private h = 0;
  constructor(private mode: StackMode) {}

  add(img: Img): void {
    if (!this.acc) {
      this.w = img.width;
      this.h = img.height;
      this.acc = new Uint8ClampedArray(img.data);
      if (this.mode === 'average') this.sum = Float64Array.from(img.data);
      this.count = 1;
      return;
    }
    if (img.width !== this.w || img.height !== this.h) return;
    const d = img.data, a = this.acc;
    if (this.mode === 'average') {
      const s = this.sum!;
      for (let i = 0; i < d.length; i++) s[i] += d[i];
    } else if (this.mode === 'lighten') {
      for (let i = 0; i < d.length; i++) if (d[i] > a[i]) a[i] = d[i];
    } else {
      for (let i = 0; i < d.length; i++) if (d[i] < a[i]) a[i] = d[i];
    }
    this.count++;
  }

  get frames(): number {
    return this.count;
  }

  result(): Img | null {
    if (!this.acc) return null;
    const out = createImg(this.w, this.h);
    if (this.mode === 'average') {
      const s = this.sum!;
      for (let i = 0; i < s.length; i++) out.data[i] = s[i] / this.count;
    } else out.data.set(this.acc);
    for (let i = 3; i < out.data.length; i += 4) out.data[i] = 255;
    return out;
  }
}

export class RollingStack {
  private ring: Img[] = [];
  private sum: Float64Array | null = null;
  constructor(private mode: StackMode, private window: number) {
    this.window = Math.max(1, Math.round(window));
  }

  push(img: Img): Img {
    if (this.ring.length && (this.ring[0].width !== img.width || this.ring[0].height !== img.height)) {
      this.ring = [];
      this.sum = null;
    }
    this.ring.push(img);
    let dropped: Img | undefined;
    if (this.ring.length > this.window) dropped = this.ring.shift();
    if (this.window === 1) return img;
    const out = createImg(img.width, img.height);
    const o = out.data;
    if (this.mode === 'average') {
      if (!this.sum) this.sum = new Float64Array(img.data.length);
      const s = this.sum;
      const d = img.data;
      for (let i = 0; i < d.length; i++) s[i] += d[i];
      if (dropped) { const x = dropped.data; for (let i = 0; i < x.length; i++) s[i] -= x[i]; }
      const n = this.ring.length;
      for (let i = 0; i < o.length; i++) o[i] = s[i] / n;
    } else {
      o.set(this.ring[0].data);
      const lighten = this.mode === 'lighten';
      for (let k = 1; k < this.ring.length; k++) {
        const d = this.ring[k].data;
        if (lighten) { for (let i = 0; i < d.length; i++) if (d[i] > o[i]) o[i] = d[i]; }
        else { for (let i = 0; i < d.length; i++) if (d[i] < o[i]) o[i] = d[i]; }
      }
    }
    for (let i = 3; i < o.length; i += 4) o[i] = 255;
    return out;
  }
}

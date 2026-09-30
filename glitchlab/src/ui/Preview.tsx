import { useEffect, useRef, useState, type ReactNode } from 'react';
import { resolveCrop, ASPECTS } from '../effects/geometry';
import type { Params } from '../effects/types';

interface Props {
  before: ImageBitmap | null;
  after: ImageBitmap | null;
  split: number;
  onSplit: (v: number) => void;
  showBefore: boolean;
  busy: boolean;
  /** Crop editing: params of the geometry effect + full-res size of the frame shown. */
  crop: { params: Params; onChange: (p: Partial<Params>) => void } | null;
  empty: ReactNode;
}

function BitmapCanvas({ bmp, className }: { bmp: ImageBitmap | null; className?: string }): ReactNode {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !bmp) return;
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext('2d')!.drawImage(bmp, 0, 0);
  }, [bmp]);
  return <canvas ref={ref} className={className} />;
}

/**
 * Display scale for the preview: shrink smoothly to fit, but only enlarge by
 * whole factors — non-integer upscaling of dithered/pixel art causes moiré.
 */
function useFitScale(viewport: React.RefObject<HTMLDivElement | null>, w: number, h: number): number {
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [viewport]);
  if (!w || !h || !box.w) return 1;
  const fit = Math.min((box.w - 24) / w, (box.h - 24) / h);
  return fit >= 1 ? Math.max(1, Math.floor(fit)) : Math.max(0.05, fit);
}

export function Preview({ before, after, split, onSplit, showBefore, busy, crop, empty }: Props): ReactNode {
  const frameRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const scale = useFitScale(viewportRef, after?.width ?? 0, after?.height ?? 0);

  const startSplitDrag = (e: React.PointerEvent): void => {
    const el = frameRef.current;
    if (!el) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent): void => {
      const r = el.getBoundingClientRect();
      onSplit(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)));
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  if (!after) {
    return <div className="viewport" ref={viewportRef}>{empty}{busy && <span className="busy-dot">▮ rendering…</span>}</div>;
  }

  // When editing the crop, show the full (uncropped) frame with a box overlay.
  let cropBox: ReactNode = null;
  if (crop) {
    const W = after.width, H = after.height;
    const r = resolveCrop(W, H, crop.params);
    const ratio = ASPECTS[String(crop.params.aspect)] ?? null;
    const startDrag = (e: React.PointerEvent, mode: 'move' | 'resize'): void => {
      e.preventDefault();
      e.stopPropagation();
      const el = frameRef.current!;
      const rect = el.getBoundingClientRect();
      const sx = e.clientX, sy = e.clientY;
      const start = { ...r };
      const move = (ev: PointerEvent): void => {
        const dx = ((ev.clientX - sx) / rect.width) * W;
        const dy = ((ev.clientY - sy) / rect.height) * H;
        if (mode === 'move') {
          const x = Math.max(0, Math.min(W - start.w, start.x + dx));
          const y = Math.max(0, Math.min(H - start.h, start.y + dy));
          crop.onChange({ cropX: x / W, cropY: y / H, cropW: start.w / W, cropH: start.h / H });
        } else {
          let w = Math.max(8, Math.min(W - start.x, start.w + dx));
          let h = Math.max(8, Math.min(H - start.y, start.h + dy));
          if (ratio) {
            // keep the ratio, limited by the frame
            h = w / ratio;
            if (start.y + h > H) { h = H - start.y; w = h * ratio; }
          }
          crop.onChange({ cropX: start.x / W, cropY: start.y / H, cropW: w / W, cropH: h / H });
        }
      };
      const up = (): void => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    };
    cropBox = (
      <div
        className="crop-box"
        data-testid="crop-box"
        style={{ left: `${(r.x / W) * 100}%`, top: `${(r.y / H) * 100}%`, width: `${(r.w / W) * 100}%`, height: `${(r.h / H) * 100}%` }}
        onPointerDown={(e) => startDrag(e, 'move')}
      >
        <div className="h" onPointerDown={(e) => startDrag(e, 'resize')} />
      </div>
    );
  }

  const sameSize = before && before.width === after.width && before.height === after.height;
  const showSplit = !crop && !showBefore && before && split > 0;
  return (
    <div className="viewport" ref={viewportRef}>
      <div
        className={'frame' + (scale > 1 ? ' upscaled' : '')}
        ref={frameRef}
        data-testid="preview-frame"
        style={{ width: Math.round(after.width * scale), height: Math.round(after.height * scale) }}
      >
        {/* base layer defines the frame's size: always the output */}
        <BitmapCanvas bmp={crop ? after : showBefore && before && sameSize ? before : after} className="base" />
        {showBefore && before && !sameSize && <BitmapCanvas bmp={before} className="after" />}
        {showSplit && (
          <>
            <div className="after" style={{ clipPath: `inset(0 ${(1 - split) * 100}% 0 0)`, position: 'absolute', inset: 0 }}>
              <BitmapCanvas bmp={before} className="after" />
            </div>
            <div className="split-handle" style={{ left: `calc(${split * 100}% - 1px)` }} onPointerDown={startSplitDrag} role="slider" aria-label="Before/after split" aria-valuenow={Math.round(split * 100)} tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft') onSplit(Math.max(0, split - 0.05));
                if (e.key === 'ArrowRight') onSplit(Math.min(1, split + 0.05));
              }} />
            <span className="tag l">BEFORE</span>
            <span className="tag r">AFTER</span>
          </>
        )}
        {showBefore && <span className="tag l">BEFORE</span>}
        {cropBox}
      </div>
      {busy && <span className="busy-dot">▮ rendering…</span>}
    </div>
  );
}

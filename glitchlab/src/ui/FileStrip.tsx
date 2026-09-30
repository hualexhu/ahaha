import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { FileKind, FileMeta } from '../worker/protocol';

export interface LoadedFile {
  id: string;
  name: string;
  file: File;
  kind: FileKind;
  meta?: FileMeta;
  thumb?: ImageBitmap;
  error?: string;
}

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;
const HEIC_EXT = /\.(heic|heif)$/i;

export function classify(f: File): FileKind | 'heic' | null {
  if (HEIC_EXT.test(f.name) || /heic|heif/.test(f.type)) return 'heic';
  if (f.type.startsWith('video/') || VIDEO_EXT.test(f.name)) return 'video';
  if (f.type.startsWith('image/') || IMAGE_EXT.test(f.name)) return 'image';
  return null;
}

function Thumb({ bmp }: { bmp?: ImageBitmap }): ReactNode {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!bmp || !ref.current) return;
    ref.current.width = bmp.width;
    ref.current.height = bmp.height;
    ref.current.getContext('2d')!.drawImage(bmp, 0, 0);
  }, [bmp]);
  return <canvas ref={ref} />;
}

interface Props {
  files: LoadedFile[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onAdd: (files: File[]) => void;
  onRemove: (id: string) => void;
}

export function FileStrip({ files, activeId, onSelect, onAdd, onRemove }: Props): ReactNode {
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  return (
    <aside className="strip" aria-label="Files">
      <div
        className={'dropzone' + (drag ? ' drag' : '')}
        onClick={() => input.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          onAdd(Array.from(e.dataTransfer.files));
        }}
        role="button"
        tabIndex={0}
      >
        ⊕ drop files<br />or click
        <input
          ref={input}
          type="file"
          data-testid="file-input"
          multiple
          accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,video/quicktime,.mov,.mp4,.webm"
          style={{ display: 'none' }}
          onChange={(e) => {
            onAdd(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
      </div>
      {files.map((f) => (
        <div
          key={f.id}
          className={'thumb' + (f.id === activeId ? ' active' : '')}
          onClick={() => onSelect(f.id)}
          data-testid="thumb"
          title={f.name}
        >
          {f.thumb ? <Thumb bmp={f.thumb} /> : <div className="loading">{f.error ? '⚠ error' : 'loading…'}</div>}
          <span className="badge">{f.kind === 'video' ? '▶ VID' : 'IMG'}</span>
          <span className="name">{f.name}</span>
          <button className="x small" aria-label={`Remove ${f.name}`} onClick={(e) => { e.stopPropagation(); onRemove(f.id); }}>×</button>
        </div>
      ))}
    </aside>
  );
}

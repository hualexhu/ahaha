import { useEffect, useRef, type ReactNode } from 'react';
import type { FileKind, FileMeta } from '../worker/protocol';
import { Icon } from './Icons';

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

export const ACCEPT = 'image/jpeg,image/png,image/webp,video/mp4,video/webm,video/quicktime,.mov,.mp4,.webm';

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
  onPick: () => void;
  onRemove: (id: string) => void;
}

export function FileStrip({ files, activeId, onSelect, onPick, onRemove }: Props): ReactNode {
  return (
    <aside className="rail" aria-label="Files">
      <button type="button" className="rail-add" onClick={onPick} title="Add photos or videos" aria-label="Add files">
        <Icon name="plus" size={18} />
      </button>
      <div className="rail-list">
        {files.map((f) => (
          <div
            key={f.id}
            className={'thumb' + (f.id === activeId ? ' active' : '') + (f.error ? ' error' : '')}
            onClick={() => onSelect(f.id)}
            data-testid="thumb"
            title={f.name}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && onSelect(f.id)}
          >
            <div className="thumb-img">
              {f.thumb ? <Thumb bmp={f.thumb} /> : <span className="thumb-loading">{f.error ? <Icon name="warn" size={16} /> : <span className="spinner" />}</span>}
              {f.kind === 'video' && <span className="badge"><Icon name="play" size={8} /></span>}
            </div>
            <span className="name">{f.name}</span>
            <button type="button" className="thumb-x" aria-label={`Remove ${f.name}`} onClick={(e) => { e.stopPropagation(); onRemove(f.id); }}>
              <Icon name="close" size={10} />
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}

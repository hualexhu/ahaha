import type { Pipeline } from '../core/pipeline';
import type { VideoSettings } from '../core/video';

export type FileKind = 'image' | 'video';

export interface FileMeta {
  kind: FileKind;
  width: number;
  height: number;
  duration?: number;
  fps?: number;
  warnings: string[];
}

export type ImageExportFormat = 'png' | 'jpeg' | 'webp' | 'jpeg-raw';
export type VideoExportFormat = 'mp4' | 'webm' | 'gif';

export interface ExportOptions {
  imageFormat: ImageExportFormat;
  videoFormat: VideoExportFormat;
  /** JPEG/WebP quality 0..1 */
  quality: number;
  gifFps: number;
  gifWidth: number;
}

export type Request =
  | { type: 'open'; fileId: string; file: Blob; kind: FileKind }
  | { type: 'close'; fileId: string }
  | {
      type: 'preview';
      fileId: string;
      pipeline: Pipeline;
      video: VideoSettings;
      /** Source time in seconds (videos). */
      time: number;
      /** 'crop': skip geometry so the crop box can be drawn over the full frame. */
      mode: 'normal' | 'crop';
    }
  | { type: 'exportImage'; file: Blob; kind: FileKind; pipeline: Pipeline; video: VideoSettings; time: number; options: ExportOptions }
  | { type: 'exportText'; file: Blob; kind: FileKind; pipeline: Pipeline; video: VideoSettings; time: number }
  | { type: 'exportVideo'; file: Blob; name: string; pipeline: Pipeline; video: VideoSettings; options: ExportOptions }
  | {
      type: 'exportBatch';
      items: { file: Blob; name: string; kind: FileKind }[];
      pipeline: Pipeline;
      video: VideoSettings;
      options: ExportOptions;
      presetName: string | null;
    };

export interface PreviewResult {
  before: ImageBitmap;
  after: ImageBitmap;
  /** Estimated full-resolution output size. */
  outWidth: number;
  outHeight: number;
  notes: string[];
  ms: number;
  frameIndex: number;
  frames: number;
}

export interface ExportResult {
  blob: Blob;
  ext: string;
  notes: string[];
  /** For video: frames written */
  frames?: number;
}

export interface Progress {
  done: number;
  total: number;
  label: string;
}

export type Response =
  | { id: number; kind: 'result'; result: unknown }
  | { id: number; kind: 'error'; error: string }
  | { id: number; kind: 'progress'; progress: Progress }
  | { id: number; kind: 'superseded' };

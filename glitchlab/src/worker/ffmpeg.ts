/// <reference lib="webworker" />
/**
 * ffmpeg.wasm (single-threaded @ffmpeg/core) loaded directly in our worker.
 *
 * Lessons from real videos: one long-lived ffmpeg instance degrades after
 * dozens of runs (an x264 run hung after ~100 runs in one instance and
 * finished in 2 s in a fresh one; users saw "memory access out of bounds").
 * So the wasm module is compiled once per worker, and callers create cheap
 * fresh *instances* (tens of ms) per job. Source files are mounted with
 * WORKERFS, which reads the user's File in place instead of copying it into
 * memory.
 */
import coreURL from '@ffmpeg/core?url';
import wasmURL from '@ffmpeg/core/wasm?url';

interface FSNode {
  contents?: unknown;
}
export interface EmFS {
  writeFile(path: string, data: Uint8Array): void;
  readFile(path: string): Uint8Array;
  unlink(path: string): void;
  stat(path: string): { size: number };
  mkdir(path: string): void;
  mount(type: unknown, opts: object, mountpoint: string): void;
  unmount(mountpoint: string): void;
  filesystems: Record<string, unknown>;
  makedev(major: number, minor: number): number;
  registerDevice(dev: number, ops: DeviceOps): void;
  mkdev(path: string, dev: number): FSNode;
  open(path: string, flags: string): object;
  write(stream: object, buffer: Uint8Array, offset: number, length: number, position?: number, canOwn?: boolean): number;
  close(stream: object): void;
}
export interface DeviceOps {
  open(stream: object): void;
  close(stream: object): void;
  read(stream: object, buffer: Uint8Array, offset: number, length: number, position: number): number;
  write(stream: object, buffer: Uint8Array, offset: number, length: number, position?: number): number;
}
interface FFmpegCore {
  FS: EmFS;
  HEAPU8: Uint8Array;
  exec(...args: string[]): number;
  ffprobe(...args: string[]): number;
  ret: number;
  reset(): void;
  setLogger(fn: (e: { type: string; message: string }) => void): void;
  setTimeout(ms: number): void;
}
type CoreFactory = (opts: object) => Promise<FFmpegCore>;

interface Compiled {
  module: WebAssembly.Module;
  factory: CoreFactory;
  core: string;
  wasm: string;
}
let compiled: Promise<Compiled> | null = null;

function compileOnce(): Promise<Compiled> {
  if (!compiled) {
    compiled = (async () => {
      const abs = (u: string): string => new URL(u, self.location.href).href;
      const core = abs(coreURL);
      const wasm = abs(wasmURL);
      const factory = ((await import(/* @vite-ignore */ core)) as { default: CoreFactory }).default;
      let module: WebAssembly.Module;
      try {
        module = await WebAssembly.compileStreaming(fetch(wasm));
      } catch {
        // hosts that don't serve application/wasm
        module = await WebAssembly.compile(await (await fetch(wasm)).arrayBuffer());
      }
      return { module, factory, core, wasm };
    })();
    compiled.catch(() => {
      compiled = null;
    });
  }
  return compiled;
}

/** Errors that mean the wasm instance itself is broken (as opposed to ffmpeg reporting a problem). */
export function isEngineCrash(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /memory access out of bounds|out of bounds memory|RuntimeError|unreachable|out of memory|Maximum call stack|index out of bounds/i.test(msg);
}

export class FFInstance {
  private sink: ((line: string) => void) | null = null;
  private mounts = new Map<string, string>();
  private runs = 0;
  private constructor(private readonly ff: FFmpegCore) {
    ff.setLogger((e) => this.sink?.(e.message));
  }

  static async create(): Promise<FFInstance> {
    const { module, factory, core, wasm } = await compileOnce();
    const ff = await factory({
      mainScriptUrlOrBlob: `${core}#${btoa(JSON.stringify({ wasmURL: wasm, workerURL: '' }))}`,
      instantiateWasm: (imports: WebAssembly.Imports, receive: (i: WebAssembly.Instance, m: WebAssembly.Module) => void) => {
        void WebAssembly.instantiate(module, imports).then((instance) => receive(instance, module));
        return {};
      },
    });
    return new FFInstance(ff);
  }

  get fs(): EmFS {
    return this.ff.FS;
  }

  /** Number of ffmpeg runs made on this instance. */
  get runCount(): number {
    return this.runs;
  }

  heapBytes(): number {
    return this.ff.HEAPU8.length;
  }

  /** Run the ffmpeg CLI synchronously. Throws only when the engine itself crashes. */
  run(args: string[]): { code: number; log: string[] } {
    const log: string[] = [];
    this.sink = (l) => log.push(l);
    this.runs++;
    try {
      this.ff.setTimeout(-1);
      this.ff.exec('-nostdin', '-hide_banner', '-y', ...args);
      const code = this.ff.ret;
      this.ff.reset();
      return { code, log };
    } finally {
      this.sink = null;
    }
  }

  /** Run ffprobe synchronously; returns stdout+stderr lines. */
  probe(args: string[]): { code: number; log: string[] } {
    const log: string[] = [];
    this.sink = (l) => log.push(l);
    this.runs++;
    try {
      this.ff.setTimeout(-1);
      this.ff.ffprobe(...args);
      const code = this.ff.ret;
      this.ff.reset();
      return { code, log };
    } finally {
      this.sink = null;
    }
  }

  /** Mount a Blob read-only (no copy) and return its path. */
  mount(key: string, blob: Blob, ext: string): string {
    const existing = this.mounts.get(key);
    if (existing) return existing;
    const dir = `/in_${key.replace(/[^\w-]/g, '_')}`;
    const name = `source.${ext}`;
    this.fs.mkdir(dir);
    this.fs.mount(this.fs.filesystems.WORKERFS, { blobs: [{ name, data: blob }] }, dir);
    const path = `${dir}/${name}`;
    this.mounts.set(key, path);
    return path;
  }

  unmount(key: string): void {
    const path = this.mounts.get(key);
    if (!path) return;
    try {
      this.fs.unmount(path.slice(0, path.lastIndexOf('/')));
    } catch {
      /* already gone */
    }
    this.mounts.delete(key);
  }

  /** Write a file, letting MEMFS take ownership of the buffer instead of copying it. */
  writeOwned(path: string, data: Uint8Array): void {
    const stream = this.fs.open(path, 'w');
    this.fs.write(stream, data, 0, data.length, 0, true);
    this.fs.close(stream);
  }

  readAndRemove(path: string): Uint8Array {
    const data = this.fs.readFile(path);
    this.remove(path);
    return data;
  }

  remove(path: string): void {
    try {
      this.fs.unlink(path);
    } catch {
      /* already gone */
    }
  }

  exists(path: string): boolean {
    try {
      this.fs.stat(path);
      return true;
    } catch {
      return false;
    }
  }
}

import type { Progress, Request, Response } from './protocol';

export class SupersededError extends Error {
  constructor() {
    super('superseded');
  }
}
export class CancelledError extends Error {
  constructor() {
    super('cancelled');
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onProgress?: (p: Progress) => void;
}

/** Promise-based wrapper around one processing worker. */
export class WorkerClient {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();

  constructor(private readonly name: string) {}

  private ensure(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./processor.worker.ts', import.meta.url), { type: 'module', name: this.name });
      this.worker.onmessage = (ev: MessageEvent<Response>) => this.onMessage(ev.data);
      this.worker.onerror = (ev) => {
        const err = new Error(ev.message || 'worker crashed');
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        this.worker?.terminate();
        this.worker = null;
      };
    }
    return this.worker;
  }

  private onMessage(msg: Response): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    if (msg.kind === 'progress') {
      p.onProgress?.(msg.progress);
      return;
    }
    this.pending.delete(msg.id);
    if (msg.kind === 'result') p.resolve(msg.result);
    else if (msg.kind === 'superseded') p.reject(new SupersededError());
    else p.reject(new Error(msg.error));
  }

  request<T>(req: Request, onProgress?: (p: Progress) => void): Promise<T> {
    const w = this.ensure();
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
      w.postMessage({ id, req });
    });
  }

  /** Hard cancel: kill the worker (and whatever ffmpeg run is in flight). It is recreated on the next request. */
  cancelAll(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values()) p.reject(new CancelledError());
    this.pending.clear();
  }

  get busy(): boolean {
    return this.pending.size > 0;
  }
}

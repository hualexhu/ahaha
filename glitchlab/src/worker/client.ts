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
export class TimeoutError extends Error {}

interface Pending {
  req: Request;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onProgress?: (p: Progress) => void;
  timeoutMs?: number;
  timer?: ReturnType<typeof setTimeout>;
}

export interface RequestOptions {
  /**
   * Watchdog: if the worker hasn't answered after this long, it is assumed
   * stuck (ffmpeg runs block the worker, so it can't be interrupted from
   * inside). It is restarted, this request fails with a TimeoutError, and
   * every other in-flight request is sent again to the new worker.
   */
  timeoutMs?: number;
}

/** Promise-based wrapper around one processing worker. */
export class WorkerClient {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  /** Files the worker has opened, re-opened automatically if the worker is replaced. */
  private opened = new Map<string, Extract<Request, { type: 'open' }>>();

  constructor(private readonly name: string) {}

  private ensure(): Worker {
    if (!this.worker) {
      const w = new Worker(new URL('./processor.worker.ts', import.meta.url), { type: 'module', name: this.name });
      w.onmessage = (ev: MessageEvent<Response>) => this.onMessage(ev.data);
      w.onerror = (ev) => {
        ev.preventDefault?.();
        this.kill();
        this.failAll(new Error(ev.message || 'the processing worker crashed'));
      };
      this.worker = w;
      // a replacement worker starts empty: re-open what the old one had (answers are ignored)
      for (const req of this.opened.values()) w.postMessage({ id: ++this.seq, req });
    }
    return this.worker;
  }

  private kill(): void {
    this.worker?.terminate();
    this.worker = null;
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private onMessage(msg: Response): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    if (msg.kind === 'progress') {
      p.onProgress?.(msg.progress);
      return;
    }
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    if (msg.kind === 'result') {
      if (p.req.type === 'open') this.opened.set(p.req.fileId, p.req);
      p.resolve(msg.result);
    } else if (msg.kind === 'superseded') p.reject(new SupersededError());
    else p.reject(new Error(msg.error));
  }

  private send(id: number, p: Pending): void {
    const w = this.ensure();
    if (p.timeoutMs) p.timer = setTimeout(() => this.timedOut(id), p.timeoutMs);
    w.postMessage({ id, req: p.req });
  }

  private timedOut(id: number): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (p.req.type === 'open') this.opened.delete(p.req.fileId);
    this.kill();
    p.reject(new TimeoutError(`no answer after ${Math.round((p.timeoutMs ?? 0) / 1000)} s`));
    // everything else that was in flight goes to the fresh worker
    const rest = [...this.pending.entries()];
    this.pending.clear();
    for (const [rid, rp] of rest) {
      clearTimeout(rp.timer);
      this.pending.set(rid, rp);
      this.send(rid, rp);
    }
  }

  request<T>(req: Request, onProgress?: (p: Progress) => void, options: RequestOptions = {}): Promise<T> {
    if (req.type === 'close') this.opened.delete(req.fileId);
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const p: Pending = { req, resolve: resolve as (v: unknown) => void, reject, onProgress, timeoutMs: options.timeoutMs };
      this.pending.set(id, p);
      this.send(id, p);
    });
  }

  /** Hard cancel: kill the worker (and whatever ffmpeg run is in flight). It is recreated on the next request. */
  cancelAll(): void {
    this.kill();
    for (const p of this.pending.values()) clearTimeout(p.timer);
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) p.reject(new CancelledError());
  }

  get busy(): boolean {
    return this.pending.size > 0;
  }
}

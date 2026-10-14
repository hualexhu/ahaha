import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TimeoutError, WorkerClient } from '../../src/worker/client';
import type { Request } from '../../src/worker/protocol';

/** A stand-in Worker: records messages; answers only when told to. */
class FakeWorker {
  static all: FakeWorker[] = [];
  sent: { id: number; req: Request }[] = [];
  terminated = false;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(msg: { id: number; req: Request }): void {
    this.sent.push(msg);
  }
  terminate(): void {
    this.terminated = true;
  }
  answer(id: number, result: unknown = true): void {
    this.onmessage?.({ data: { id, kind: 'result', result } });
  }
}

const open = (fileId: string): Request => ({ type: 'open', fileId, file: new Blob(), kind: 'video' });
const close = (fileId: string): Request => ({ type: 'close', fileId });

describe('WorkerClient watchdog', () => {
  beforeEach(() => {
    FakeWorker.all = [];
    vi.stubGlobal('Worker', FakeWorker);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('fails a request the worker never answers and replaces the worker', async () => {
    const c = new WorkerClient('t');
    const p = c.request(open('a'), undefined, { timeoutMs: 1000 });
    const failed = expect(p).rejects.toBeInstanceOf(TimeoutError);
    vi.advanceTimersByTime(1001);
    await failed;
    expect(FakeWorker.all[0].terminated).toBe(true);
    // the next request gets a fresh worker
    void c.request(close('a'));
    expect(FakeWorker.all).toHaveLength(2);
  });

  it('re-sends other in-flight requests and re-opens open files on the new worker', async () => {
    const c = new WorkerClient('t');
    const a = c.request(open('a'));
    const w1 = FakeWorker.all[0];
    w1.answer(w1.sent[0].id, 'opened a');
    await expect(a).resolves.toBe('opened a');

    const stuck = c.request(open('b'), undefined, { timeoutMs: 1000 });
    const waiting = c.request(open('c'));
    const stuckFailed = expect(stuck).rejects.toBeInstanceOf(TimeoutError);
    vi.advanceTimersByTime(1001);
    await stuckFailed;

    const w2 = FakeWorker.all[1];
    // a (already open) is replayed, b (the stuck one) is not, c is re-sent under its original id
    expect(w2.sent.map((m) => (m.req as { fileId: string }).fileId)).toEqual(['a', 'c']);
    const cId = w2.sent[1].id;
    w2.answer(cId, 'opened c');
    await expect(waiting).resolves.toBe('opened c');
  });

  it('a closed file is not re-opened', async () => {
    const c = new WorkerClient('t');
    const a = c.request(open('a'));
    FakeWorker.all[0].answer(FakeWorker.all[0].sent[0].id);
    await a;
    void c.request(close('a'));
    const stuck = c.request(open('b'), undefined, { timeoutMs: 10 });
    const failed = expect(stuck).rejects.toBeInstanceOf(TimeoutError);
    vi.advanceTimersByTime(11);
    await failed;
    // the close was still pending, so it is re-sent; 'a' is not replayed
    expect(FakeWorker.all[1].sent.map((m) => m.req.type)).toEqual(['close']);
  });
});

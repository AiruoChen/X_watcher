import type { CallGate, Clock } from '../../../domain/ports.js';
import { BudgetExceeded, SourceFailure } from '../../../domain/errors.js';
import { DeadlineContext } from '../../execution.js';

export type XTransport = (url: URL, init: RequestInit) => Promise<Response>;
export interface XClientOptions {
  readonly token: string;
  readonly calls?: CallGate;
  readonly clock: Clock;
  readonly timeoutMs: number;
  readonly transport?: XTransport;
  readonly maxResponseBytes?: number;
}
/** Fixed-origin GET-only transport. No redirects, raw errors, automatic retries or credential logging. */
export class XClient {
  private readonly transport: XTransport;
  readonly #token: string;
  private readonly clock: Clock;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly gates = new Map<string, { wall: number; mono: number }>();
  private calls = 0;
  private readonly callGate: CallGate | undefined;
  get budgeted(): boolean { return this.callGate !== undefined; }
  constructor(options: XClientOptions) {
    if (!options.token || /[\s\r\n\0]/.test(options.token)) throw new SourceFailure('authentication', false);
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) throw new SourceFailure('protocol', false);
    this.callGate = options.calls;
    this.#token = options.token; this.clock = options.clock; this.timeoutMs = options.timeoutMs;
    this.transport = options.transport ?? ((url, init) => fetch(url, init));
    this.maxBytes = options.maxResponseBytes ?? 4_000_000;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) throw new SourceFailure('protocol', false);
  }
  get requestCount(): number { return this.calls; }
  private retryAt(headers: Headers): string | null {
    const now = this.clock.now().getTime(), date = Date.parse(headers.get('date') ?? '');
    const server = Number.isFinite(date) ? date : now;
    const seconds = headers.get('retry-after'), reset = headers.get('x-rate-limit-reset');
    const delays: number[] = [];
    if (seconds && /^\d+$/.test(seconds)) delays.push(Number(seconds) * 1000);
    else if (seconds && Number.isFinite(Date.parse(seconds))) delays.push(Date.parse(seconds) - server);
    if (reset && /^\d+$/.test(reset)) delays.push(Number(reset) * 1000 - server);
    const delay = Math.max(0, ...delays.filter(Number.isFinite));
    return delay > 0 && now + delay < 8.64e15 ? new Date(now + delay).toISOString() : null;
  }
  async get(path: string, params: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<unknown> {
    if (!/^\/2\/users\/by\/username\/[a-zA-Z0-9_]{1,15}$/.test(path) && path !== '/2/tweets/search/recent')
      throw new SourceFailure('protocol', false);
    const gateKey = path.startsWith('/2/users/') ? '/2/users/by/username/:username' : path;
    const gate = this.gates.get(gateKey);
    if (gate && this.clock.monotonicMs() < gate.mono) throw new SourceFailure('rate_limited', true,
      new Date(this.clock.now().getTime() + gate.mono - this.clock.monotonicMs()).toISOString());
    const url = new URL(path, 'https://api.x.com');
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const parent = signal ?? new AbortController().signal;
    try {
      return await new DeadlineContext(parent).call(async deadline => {
        const permit = this.callGate?.reserve('source');
        const request = async () => { this.calls++; return this.transport(url, { method: 'GET', redirect: 'error', signal: deadline,
          headers: { authorization: `Bearer ${this.#token}`, accept: 'application/json' } }); };
        const response = permit ? await permit.run(request) : await request();
        const retryAt = this.retryAt(response.headers);
        if ((response.status === 429 || response.headers.get('x-rate-limit-remaining') === '0') && retryAt) {
          const wall = Date.parse(retryAt); this.gates.set(gateKey, { wall, mono: this.clock.monotonicMs() + Math.max(0, wall - this.clock.now().getTime()) });
        }
        if (response.status !== 200) {
          await response.body?.cancel();
          if (response.status === 401) throw new SourceFailure('authentication', false);
          if (response.status === 402) throw new SourceFailure('credits_exhausted', false);
          if (response.status === 403) throw new SourceFailure('permission', false);
          if (response.status === 404) throw new SourceFailure('not_found', false);
          if (response.status === 429) throw new SourceFailure('rate_limited', true, retryAt);
          throw new SourceFailure(response.status >= 500 ? 'provider' : 'protocol', response.status >= 500, retryAt);
        }
        if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
          await response.body?.cancel(); throw new SourceFailure('protocol', false);
        }
        if (!response.body) throw new SourceFailure('protocol', false);
        const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
        const cancel = (): void => { void reader.cancel().catch(() => undefined); };
        deadline.addEventListener('abort', cancel, { once: true });
        try {
          while (true) {
            const chunk = await reader.read(); if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > this.maxBytes) { await reader.cancel(); throw new SourceFailure('protocol', false); }
            chunks.push(chunk.value);
          }
        } finally { deadline.removeEventListener('abort', cancel); reader.releaseLock(); }
        const body = new Uint8Array(bytes); let offset = 0;
        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
        try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown; }
        catch { throw new SourceFailure('protocol', false); }
      }, this.timeoutMs);
    } catch (error) {
      if (error instanceof SourceFailure || error instanceof BudgetExceeded) throw error;
      if (parent.aborted) throw new SourceFailure('cancelled', true);
      if (error instanceof Error && error.message.startsWith('Operation deadline')) throw new SourceFailure('timeout', true);
      throw new SourceFailure('network', true);
    }
  }
}

import type { Clock } from '../../../domain/ports.js';
import type { RuntimeConfig } from '../../../domain/model.js';
import { SourceFailure } from '../../../domain/errors.js';
import { DeadlineContext } from '../../execution.js';

export type RsshubTransport = (url: URL, init: RequestInit) => Promise<Response>;
/** GET-only JSON Feed reader. Never sends X credentials or follows feed-provided URLs. */
export class RsshubClient {
  private calls = 0;
  private gateMono = 0;
  constructor(private readonly config: RuntimeConfig['rsshub'], private readonly clock: Clock,
    private readonly transport: RsshubTransport = (url, init) => fetch(url, init), private readonly maxBytes = 4_000_000) {}
  get requestCount(): number { return this.calls; }
  async timeline(handle: string, signal?: AbortSignal): Promise<unknown> {
    if (!/^[a-zA-Z0-9_]{1,15}$/.test(handle)) throw new SourceFailure('identity_mismatch', false);
    if (this.clock.monotonicMs() < this.gateMono) throw new SourceFailure('rate_limited', true,
      new Date(this.clock.now().getTime() + this.gateMono - this.clock.monotonicMs()).toISOString());
    const url = new URL(this.config.baseUrl + '/twitter/user/' + handle + '/'
      + 'includeReplies=true&includeRts=false&count=' + this.config.itemLimit
      + '&showSymbolForRetweetAndReply=false&showEmojiForRetweetAndReply=false'
      + '&showAuthorInDesc=false&showAuthorInTitle=false&includeReplyContext=false'
      + '&showTimestampInDescription=false&showQuotedInTitle=false');
    url.searchParams.set('format', 'json');
    const parent = signal ?? new AbortController().signal;
    try {
      return await new DeadlineContext(parent).call(async deadline => {
        this.calls++;
        const response = await this.transport(url, { method: 'GET', redirect: 'error', signal: deadline,
          headers: { accept: 'application/feed+json, application/json' } });
        const rawRetry = response.headers.get('retry-after');
        const server = Date.parse(response.headers.get('date') ?? '');
        const delay = rawRetry && /^\d+$/.test(rawRetry) ? Number(rawRetry) * 1000
          : rawRetry ? Date.parse(rawRetry) - (Number.isFinite(server) ? server : this.clock.now().getTime()) : NaN;
        const retryAt = Number.isFinite(delay) && delay > 0 && this.clock.now().getTime() + delay < 8.64e15
          ? new Date(this.clock.now().getTime() + delay).toISOString() : null;
        if (response.status !== 200) {
          await response.body?.cancel();
          if (response.status === 401) throw new SourceFailure('authentication', false);
          if (response.status === 403) throw new SourceFailure('permission', false);
          if (response.status === 404) throw new SourceFailure('not_found', false);
          if (response.status === 429) {
            if (retryAt) this.gateMono = this.clock.monotonicMs() + delay;
            throw new SourceFailure('rate_limited', true, retryAt);
          }
          throw new SourceFailure(response.status >= 500 ? 'provider' : 'protocol', response.status >= 500, retryAt);
        }
        const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
        if (!['application/feed+json', 'application/json'].includes(contentType ?? '') || !response.body) {
          await response.body?.cancel(); throw new SourceFailure('protocol', false);
        }
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
      }, this.config.requestTimeoutMs);
    } catch (error) {
      if (error instanceof SourceFailure) throw error;
      if (parent.aborted) throw new SourceFailure('cancelled', true);
      if (error instanceof Error && error.message.startsWith('Operation deadline')) throw new SourceFailure('timeout', true);
      throw new SourceFailure('network', true);
    }
  }
}

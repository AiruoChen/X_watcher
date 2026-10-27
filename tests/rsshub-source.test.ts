import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { loadConfig, describeConfig } from '../src/config.js';
import { RsshubClient, type RsshubTransport } from '../src/adapters/source/rsshub/client.js';
import { RsshubSource } from '../src/adapters/source/rsshub/source.js';
import { mapFeed, authorText } from '../src/adapters/source/rsshub/mapper.js';
import { createReadonlySource } from '../src/bootstrap-source.js';
import { ManualClock } from '../src/adapters/clock.js';
import { SourceFailure } from '../src/domain/errors.js';
import { MemoryStore } from '../src/adapters/storage/memory-store.js';
import { SqliteStore } from '../src/adapters/storage/sqlite/store.js';
import { Sha256Hasher } from '../src/adapters/hash.js';
import { IngestTarget } from '../src/application/ingest-target.js';
import { ProcessAnalysis } from '../src/application/process-analysis.js';
import { ProbeSource } from '../src/application/probe-source.js';
import { DeadlineContext } from '../src/adapters/execution.js';
import { createRuntimeApplication } from '../src/bootstrap-runtime.js';
import { runtimeFixture } from './helpers/runtime.js';
import { temporaryStorage, cleanupStorage } from './helpers/storage.js';

const env = { APP_MODE: 'preview', STORAGE_KIND: 'sqlite', SOURCE_PROVIDER: 'rsshub', SOURCE_CREDENTIAL_ENV: '', ANALYSIS_PROVIDER: 'deferred' };
const config = loadConfig(env), target = config.targets[0]!;
const query = { from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T23:59:30.000Z' };
const context = (): DeadlineContext => new DeadlineContext(new AbortController().signal);
const item = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ id: 'https://twitter.com/thsottiaux/status/200',
  url: 'https://x.com/thsottiaux/status/200', date_published: '2026-01-01T23:59:00Z',
  content_html: 'Synthetic ChatGPT update &amp; details.<br>Limits reset tomorrow.',
  authors: [{ name: 'Synthetic author', url: 'https://x.com/thsottiaux' }], ...overrides });
const feed = (items: readonly unknown[] = [item()], overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 'https://jsonfeed.org/version/1.1', home_page_url: 'https://x.com/thsottiaux', title: 'Synthetic feed', items, ...overrides });
const code = (expected: string) => (error: unknown): boolean => error instanceof SourceFailure && error.code === expected;
function fixture(responses: readonly unknown[] = [feed()]) {
  const clock = new ManualClock(new Date('2026-01-02T00:00:00Z')), queue = [...responses];
  const requests: { url: URL; init: RequestInit }[] = [];
  const transport: RsshubTransport = async (url, init) => {
    requests.push({ url, init }); const value = queue.shift() ?? feed();
    if (value instanceof Error) throw value;
    return value instanceof Response ? value : new Response(JSON.stringify(value), { headers: { 'content-type': 'application/feed+json' } });
  };
  const client = new RsshubClient(config.rsshub, clock, transport), source = new RsshubSource(client, clock, config.rsshub);
  return { clock, client, source, requests, transport };
}

test('RSSHub configuration needs no X token and isolates handles from official X identities', () => {
  assert.equal(config.services.source.credentialEnv, null); assert.equal(target.provider, 'rsshub-x');
  assert.equal(target.id, 'rsshub-x:thsottiaux'); assert.notEqual(target.id, loadConfig({}).targets[0]!.id);
  assert.equal(config.rsshub.itemLimit, 100); assert.equal(config.rsshub.overlapMs, 48 * 3_600_000);
  assert.doesNotMatch(JSON.stringify(describeConfig(config)), /127\.0\.0\.1|rsshub-preview/);
  for (const patch of [{ RSSHUB_BASE_URL: 'file:///private' }, { RSSHUB_BASE_URL: 'http://remote.invalid' },
    { RSSHUB_BASE_URL: 'https://user:secret@host.invalid' }, { RSSHUB_BASE_URL: 'https://host.invalid?token=secret' },
    { RSSHUB_BASE_URL: 'https://host.invalid/#secret' }, { RSSHUB_ITEM_LIMIT: '0' }, { RSSHUB_ITEM_LIMIT: '201' },
    { RSSHUB_REQUEST_TIMEOUT_SECONDS: '31' }, { SOURCE_CREDENTIAL_ENV: 'X_BEARER_TOKEN' }]) {
    assert.throws(() => loadConfig({ ...env, ...patch }));
  }
  assert.equal(loadConfig({ ...env, RSSHUB_BASE_URL: 'https://rss.example.invalid/prefix/' }).rsshub.baseUrl, 'https://rss.example.invalid/prefix');
  assert.equal(loadConfig({ ...env, RSSHUB_BASE_URL: 'http://[::1]:1200' }).rsshub.baseUrl, 'http://[::1]:1200');
});

test('composition root only creates RSSHub in explicit source-only preview', () => {
  const s = fixture();
  assert.equal(createReadonlySource(config, {}, s.clock, s.transport).source.capability, 'real');
  assert.throws(() => createReadonlySource({ ...config, mode: 'demo' }, {}, s.clock, s.transport));
  assert.throws(() => createReadonlySource({ ...config, mode: 'live' }, {}, s.clock, s.transport));
  assert.equal(s.requests.length, 0);
});

test('JSON Feed maps canonical post IDs, original date and inert author text without inventing completeness', () => {
  const mapped = mapFeed(feed(), target, 100)[0]!;
  assert.equal(mapped.id, '200'); assert.equal(mapped.url, 'https://x.com/thsottiaux/status/200');
  assert.equal(mapped.publishedAt, '2026-01-01T23:59:00.000Z');
  assert.equal(mapped.text, 'Synthetic ChatGPT update & details.\nLimits reset tomorrow.');
  assert.equal(mapped.origin!.authorId, 'rsshub-handle:thsottiaux'); assert.equal(mapped.origin!.completeness, 'unknown');
  assert.equal(mapped.origin!.kind, 'unknown'); assert.deepEqual(mapped.origin!.editHistory, []);
  assert.equal(mapFeed(feed([item({ date_published: 'Thu, 01 Jan 2026 23:59:00 GMT' })]), target, 100)[0]!.publishedAt, mapped.publishedAt);
});

test('quoted and reply-context text, script and media cannot become author reset evidence', () => {
  const html = '<div class="rsshub-reply-context"><blockquote>Parent resets now</blockquote></div>'
    + '<p>My own <b>comment</b> &lt;today&gt;.</p><div class="rsshub-quote">Quoted author: reset at 10:00</div>'
    + '<script>execute()</script><video>fallback reset</video><img src="https://private.invalid/pixel">';
  assert.equal(authorText(html), 'My own comment <today>.');
  const post = mapFeed(feed([item({ content_html: html, _extra: { links: [{ type: 'quote', url: 'https://twitter.com/other/status/300' }] } })]), target, 100)[0]!;
  assert.equal(post.text, 'My own comment <today>.'); assert.equal(post.origin!.kind, 'quote');
  assert.deepEqual(post.origin!.references[0], { id: '300', kind: 'quoted', authorId: null, text: null, url: 'https://x.com/other/status/300' });
});

test('feed validation rejects malformed envelopes, identity changes, invalid dates and conflicting duplicates', () => {
  for (const value of [null, {}, feed([], { version: 'custom' }), feed([], { next_url: 'https://private.invalid' }),
    feed([], { expired: true }), feed([item()], { home_page_url: 'https://x.com/other' }),
    feed([item({ url: 'https://x.com/other/status/200' })]), feed([item({ id: 'https://x.com/thsottiaux/status/201' })]),
    feed([item({ url: 'https://evil.invalid/thsottiaux/status/200' })]), feed([item({ date_published: undefined })]),
    feed([item({ date_published: '2026-02-31T00:00:00Z' })]), feed([item({ date_published: '2026-01-01T12:00:00' })]),
    feed([item({ content_html: undefined, title: 'A truncated title' })]),
    feed([item(), item({ content_html: 'Conflicting text' })]), feed([item({ authors: [{ url: 'https://x.com/other' }] })])]) {
    assert.throws(() => mapFeed(value, target, 100), error => error instanceof SourceFailure);
  }
  assert.equal(mapFeed(feed([item(), item()]), target, 100).length, 1);
  assert.throws(() => mapFeed(feed([item(), item()]), target, 1));
});

test('source binds the feed profile, uses one GET for resolve+fetch and never sends auth headers', async () => {
  const s = fixture(); await s.source.resolve(target);
  const batch = await s.source.fetch(target, null, query);
  assert.equal(s.requests.length, 1); assert.equal(batch.complete, true);
  assert.equal(batch.coverageStatus, 'unverified'); assert.equal(batch.scope, 'rsshub_timeline_snapshot');
  assert.equal(batch.posts.length, 1); assert.equal(s.requests[0]!.url.origin, 'http://127.0.0.1:1200');
  assert.equal(s.requests[0]!.url.searchParams.get('format'), 'json');
  assert.match(s.requests[0]!.url.pathname, /includeReplies=true&includeRts=false&count=100/);
  assert.equal(s.requests[0]!.init.method, 'GET'); assert.equal(s.requests[0]!.init.redirect, 'error');
  assert.equal(new Headers(s.requests[0]!.init.headers).get('authorization'), null);
  assert.equal(new Headers(s.requests[0]!.init.headers).get('cookie'), null);
});

test('source rejects unbound targets and cursors from another provider without network reads', async () => {
  const s = fixture(); await assert.rejects(s.source.fetch(target, null, query), code('identity_mismatch'));
  assert.equal(s.requests.length, 0); await s.source.resolve(target);
  for (const cursor of ['{bad', 'null', '[]', '{"v":1,"provider":"x"}'])
    await assert.rejects(s.source.fetch(target, cursor, query), code('protocol'));
  assert.equal(s.requests.length, 1);
});

test('half-open windows defer newest posts and subsequent overlap finds late posts and edits', async () => {
  const s = fixture([feed([item({ date_published: query.to })]), feed([item()]), feed([item({ content_html: 'Edited author text.' })])]);
  const store = new MemoryStore(), ingest = new IngestTarget(s.source, store, s.clock, config, new Sha256Hasher());
  assert.equal(await ingest.execute(target, context()), 0); s.clock.advance(60_000);
  assert.equal(await ingest.execute(target, context()), 1); s.clock.advance(60_000);
  assert.equal(await ingest.execute(target, context()), 1); assert.equal(store.versions(target.id).length, 2);
  assert.equal(store.checkpoint(target.id).revision, 3); assert.equal(store.outbox().length, 0);
  assert.ok(store.coverage(target.id).every(range => range.status === 'gap' && range.reason === 'rsshub_snapshot_unverified'));
  assert.equal(store.isCovered(target.id, query), false);
});

test('SQLite saves snapshots, unverified coverage, jobs and cursor atomically and deduplicates after reopen', async () => {
  const root = temporaryStorage(), path = join(root, 'rsshub.sqlite'); let store = new SqliteStore(path, { create: true });
  const s = fixture([feed(), feed()]);
  try {
    assert.equal(await new IngestTarget(s.source, store, s.clock, config, new Sha256Hasher()).execute(target, context()), 1);
    store.close(); store = new SqliteStore(path); s.clock.advance(60_000);
    assert.equal(await new IngestTarget(s.source, store, s.clock, config, new Sha256Hasher()).execute(target, context()), 0);
    assert.equal(store.versions(target.id).length, 1); assert.equal(store.analysisJobs(target.id).length, 1);
    assert.equal(store.analysisJobs(target.id)[0]!.emitNotifications, false); assert.equal(store.checkpoint(target.id).revision, 2);
    assert.equal(store.coverage(target.id).length, 2); assert.equal(store.isCovered(target.id, query), false);
    assert.equal(store.outbox().length, 0);
  } finally { store.close(); cleanupStorage(root); }
});

test('empty feeds record only unverified observation and never prove an empty day', async () => {
  const s = fixture([feed([])]), store = new MemoryStore();
  assert.equal(await new IngestTarget(s.source, store, s.clock, config, new Sha256Hasher()).execute(target), 0);
  assert.equal(store.checkpoint(target.id).revision, 1); assert.equal(store.isCovered(target.id, query), false);
  assert.equal(store.coverage(target.id)[0]!.status, 'gap'); assert.equal(store.analysisJobs(target.id).length, 0);
});

test('invalid feed response commits no posts, pending jobs or checkpoint', async () => {
  const s = fixture([feed([item(), item({ date_published: 'bad' })])]), store = new MemoryStore();
  await assert.rejects(new IngestTarget(s.source, store, s.clock, config, new Sha256Hasher()).execute(target), code('protocol'));
  assert.equal(store.versions(target.id).length, 0); assert.equal(store.analysisJobs(target.id).length, 0);
  assert.equal(store.checkpoint(target.id).revision, 0); assert.equal(store.coverage(target.id).length, 0);
});

test('unknown RSS body completeness cannot silently enter the existing full-text analyzer', async () => {
  const s = fixture(), store = new MemoryStore(); let calls = 0;
  await new IngestTarget(s.source, store, s.clock, config, new Sha256Hasher()).execute(target);
  await new ProcessAnalysis({ capability: 'simulated', analyze: async () => { calls++; throw new Error('forbidden'); } }, store, [], s.clock, config).execute(target);
  assert.equal(calls, 0); assert.equal(store.analysisJobs(target.id)[0]!.state, 'needs_attention'); assert.equal(store.outbox().length, 0);
});

test('RSSHub read-only preview runtime performs no analysis, report or delivery calls', async () => {
  const s = runtimeFixture(env), rss = fixture(); let calls = 0;
  try {
    const { host } = s.app({ sources: new Map([['rsshub-x', rss.source]]),
      analyzer: { capability: 'simulated', analyze: async () => { calls++; throw new Error('forbidden'); } },
      notifications: { capability: 'simulated', send: async () => { calls++; throw new Error('forbidden'); } } });
    const run = host.run(); await s.waiter.step(); host.stop(); await s.waiter.step(); assert.equal((await run).exitCode, 0);
    assert.equal(calls, 0); assert.equal(s.store.checkpoint(target.id).revision, 1);
    assert.equal(s.store.analysisJobs(target.id)[0]!.state, 'pending'); assert.equal(s.store.reports(target.id).length, 0);
  } finally { s.close(); }
});

test('probe reports unverified feed scope without a database dependency', async () => {
  const s = fixture();
  const result = await new ProbeSource(s.source, s.clock, config).execute(target, context());
  assert.equal(result['status'], 'ok'); assert.equal(result['coverage'], 'unverified');
  assert.equal(result['scope'], 'rsshub_timeline_snapshot'); assert.equal(result['mail'], 'disabled');
});

test('HTTP failures are classified without response bodies or secrets', async () => {
  for (const [status, expected] of [[401,'authentication'], [403,'permission'], [404,'not_found'], [429,'rate_limited'], [503,'provider'], [400,'protocol']] as const) {
    const s = fixture([new Response('private-cookie synthetic-secret', { status })]);
    await assert.rejects(s.client.timeline(target.handle), error => code(expected)(error) && !String(error).includes('synthetic-secret'));
  }
});

test('rate limit Retry-After gate uses monotonic time across wall-clock changes', async () => {
  const s = fixture([new Response('', { status: 429, headers: { 'retry-after': '7200' } })]);
  await assert.rejects(s.client.timeline(target.handle), error => code('rate_limited')(error)
    && (error as SourceFailure).retryAt === '2026-01-02T02:00:00.000Z');
  s.clock.jumpWallClock(86_400_000); await assert.rejects(s.client.timeline(target.handle), code('rate_limited'));
  assert.equal(s.client.requestCount, 1);
});

test('client rejects HTML error pages, invalid JSON, oversized responses and invalid usernames', async () => {
  for (const response of [new Response('<html>private</html>', { headers: { 'content-type': 'text/html' } }),
    new Response('{bad', { headers: { 'content-type': 'application/json' } }),
    new Response(JSON.stringify({ huge: 'x'.repeat(100) }), { headers: { 'content-type': 'application/feed+json' } })]) {
    const client = new RsshubClient(config.rsshub, new ManualClock(new Date()), async () => response, 50);
    await assert.rejects(client.timeline(target.handle), code('protocol'));
    await assert.rejects(client.timeline('../private'), code('identity_mismatch'));
  }
});

test('timeouts and cancellation release the body reader and fence late results', async () => {
  let cancelled = false;
  const client = new RsshubClient({ ...config.rsshub, requestTimeoutMs: 10 }, new ManualClock(new Date()), async () =>
    new Response(new ReadableStream({ cancel: () => { cancelled = true; } }), { headers: { 'content-type': 'application/feed+json' } }));
  await assert.rejects(client.timeline(target.handle), code('timeout')); assert.equal(cancelled, true);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.timeline(target.handle, controller.signal), code('cancelled'));
});

test('native RSSHub transport handles synthetic feeds on loopback and refuses redirects', async () => {
  const paths: string[] = []; let redirect = false;
  const server = createServer((request, response) => {
    paths.push(request.url!);
    if (redirect) { response.writeHead(302, { location: '/do-not-follow' }); response.end(); }
    else { response.writeHead(200, { 'content-type': 'application/feed+json' }); response.end(JSON.stringify(feed())); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as AddressInfo;
    const local = loadConfig({ ...env, RSSHUB_BASE_URL: 'http://127.0.0.1:' + address.port + '/prefix' });
    const { source } = createReadonlySource(local, {}, new ManualClock(new Date('2026-01-02T00:00:00Z')));
    await source.resolve!(target); assert.equal((await source.fetch(target, null, query)).posts.length, 1);
    redirect = true; await assert.rejects(source.resolve!(target), code('network'));
    assert.equal(paths.length, 2); assert.ok(paths.every(path => path.startsWith('/prefix/twitter/user/thsottiaux/')));
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('CLI probe and one-shot persistent preview work against a synthetic RSSHub server', async () => {
  const root = temporaryStorage(), path = join(root, 'cli.sqlite');
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/feed+json' }); response.end(JSON.stringify(feed()));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as AddressInfo;
    const cliEnv = { ...process.env, ...env, ANALYSIS_CREDENTIAL_ENV: '', ANALYSIS_MODEL: '', DATABASE_PATH: path,
      RSSHUB_BASE_URL: 'http://127.0.0.1:' + address.port, RUNTIME_WAKE_MS: '10' };
    const run = async (...args: string[]): Promise<{ code: number | null; output: string }> => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--experimental-sqlite', 'dist/src/cli.js', ...args], { env: cliEnv, windowsHide: true });
      let output = ''; child.stdout.on('data', chunk => { output += String(chunk); }); child.stderr.on('data', chunk => { output += String(chunk); });
      child.on('error', reject); child.on('close', code => resolve({ code, output }));
    });
    const probe = await run('rsshub:probe'); assert.equal(probe.code, 0, probe.output); assert.equal(existsSync(path), false);
    assert.match(probe.output, /unverified/);
    const preview = await run('rsshub:preview', '--create', '--once'); assert.equal(preview.code, 0, preview.output);
    const store = new SqliteStore(path);
    try { assert.equal(store.checkpoint(target.id).revision, 1); assert.equal(store.outbox().length, 0); }
    finally { store.close(); }
    const wrongAlias = await run('x:probe'); assert.equal(wrongAlias.code, 1); assert.match(wrongAlias.output, /require SOURCE_PROVIDER=x-api-v2/);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); cleanupStorage(root); }
});

test('RSSHub rate-limit retry time is persisted and respected after SQLite restart', async () => {
  const s = runtimeFixture(env), rss = fixture([new Response('', { status: 429, headers: { 'retry-after': '7200' } })]);
  let reopened: SqliteStore | undefined;
  try {
    const first = s.app({ sources: new Map([['rsshub-x', rss.source]]) });
    const lease = s.store.runtime.acquire(86_400_000)!; first.scheduler.initialize(); first.scheduler.pulse(s.context); await first.scheduler.drain();
    const task = s.store.schedules.tasks().find(t => t.stage === 'ingest')!;
    assert.equal(task.failureCode, 'rate_limited'); assert.equal(task.retryNotBeforeAt, '2026-01-02T02:00:00.000Z');
    s.store.runtime.release(lease.revision);
    reopened = new SqliteStore(s.path, { claims: { clock: s.clock } }); let calls = 0;
    const second = createRuntimeApplication(config, { ...s.deps, store: reopened, state: reopened.schedules, lease: reopened.runtime,
      reconcile: rev => reopened!.recoverAbandonedWork(rev), sources: new Map([['rsshub-x', { capability: 'real',
        resolve: async () => { calls++; return { authorId: 'rsshub-handle:thsottiaux', handle: target.handle }; },
        fetch: async () => ({ posts: [], complete: true, nextCursor: null, scope: 'rsshub_timeline_snapshot', coverageStatus: 'unverified' }) }]]) });
    reopened.runtime.acquire(86_400_000); second.scheduler.initialize(); s.clock.advance(31 * 60_000);
    second.scheduler.pulse(s.context); await second.scheduler.drain(); assert.equal(calls, 0);
    s.clock.advance(90 * 60_000); second.scheduler.pulse(s.context); await second.scheduler.drain(); assert.equal(calls, 1);
  } finally { reopened?.close(); s.close(); }
});


for (const persistent of [false, true]) test((persistent ? 'SQLite' : 'Memory') + ': RSS snapshot commits reject fabricated completeness and roll back partial records', async () => {
  const root = persistent ? temporaryStorage() : null;
  const store = root ? new SqliteStore(join(root, 'atomic.sqlite'), { create: true }) : new MemoryStore();
  const original = store.commitIngestion.bind(store);
  let captured: import('../src/domain/ports.js').IngestionCommit | undefined;
  store.commitIngestion = commit => { captured = structuredClone(commit); };
  try {
    const s = fixture(); await new IngestTarget(s.source, store, s.clock, config, new Sha256Hasher()).execute(target);
    assert.ok(captured); store.commitIngestion = original;
    assert.throws(() => original({ ...captured!, jobs: [] }));
    assert.throws(() => original({ ...captured!, expectedRevision: 1 }));
    assert.throws(() => original({ ...captured!, coverage: { ...captured!.coverage, status: 'complete', reason: null } }));
    const { scope: _ignoredScope, ...range } = captured.coverage;
    assert.throws(() => original({ ...captured!, coverage: { ...range, status: 'complete', reason: null } }));
    assert.equal(store.versions(target.id).length, 0); assert.equal(store.analysisJobs(target.id).length, 0);
    assert.equal(store.coverage(target.id).length, 0); assert.equal(store.checkpoint(target.id).revision, 0);
    original(captured); assert.equal(store.checkpoint(target.id).revision, 1); assert.equal(store.versions(target.id).length, 1);
  } finally { if (store instanceof SqliteStore) store.close(); if (root) cleanupStorage(root); }
});

import type { RuntimeConfig } from './domain/model.js';
import { SqliteStore } from './adapters/storage/sqlite/store.js';
import { Sha256Hasher } from './adapters/hash.js';
import { BuildReport } from './application/build-report.js';
import { ReportTextRenderer } from './application/report-renderer.js';
import { digestWindowForDay } from './domain/time.js';
import { fullyAnalyzed, validDay } from './domain/policies/reporting.js';

/** Local operations never instantiate a source, model or mail client. */
export function digestOperations(config: RuntimeConfig, command: string, args: readonly string[], now = new Date()): void {
  const day = args[0];
  const flags = args.slice(1), partial = flags.includes('--partial');
  const handle = flags.find(arg => !arg.startsWith('--'));
  if (!day || !validDay(day) || flags.filter(arg => !arg.startsWith('--')).length > 1
    || flags.some(arg => arg.startsWith('--') && (arg !== '--partial' || command !== 'digest:preview')))
    throw new Error('Usage: digest:status|digest:generate <YYYY-MM-DD> [handle] | digest:preview <YYYY-MM-DD> [handle] [--partial]');
  if (config.storage.kind !== 'sqlite') throw new Error('Digest operations require existing SQLite storage.');
  const target = handle ? config.targets.find(t => t.handle.toLowerCase() === handle.replace(/^@/, '').toLowerCase()) : config.targets[0];
  if (!target) throw new Error('Unknown configured target.');
  const store = new SqliteStore(config.storage.path);
  try {
    const window = digestWindowForDay(day, config.timeZone);
    const report = new BuildReport(store, new Sha256Hasher(), new ReportTextRenderer(), config);
    if (command === 'digest:preview') {
      console.log(report.preview(target, window, now.toISOString(), partial).text); return;
    }
    if (command === 'digest:generate') {
      report.execute(target, window, now.toISOString(), true, false);
    } else if (command !== 'digest:status') throw new Error('Unknown digest command.');
    const input = store.reportInputs(target.id, window);
    console.log(JSON.stringify({ targetId: target.id, day, sourceCovered: input.covered,
      analyzed: input.items.filter(fullyAnalyzed).length, collected: input.items.length,
      lastSourceCheck: input.observation?.completedAt ?? null,
      state: input.previous?.state ?? (input.boundary && day >= input.boundary.firstDay && day < input.boundary.beforeDay
        ? 'skipped_by_policy' : input.progress?.state ?? 'not_generated'),
      progress: input.progress?.state ?? null, incidentOpen: input.progress?.incidentOpen ?? false,
      incidentClosed: input.progress?.incidentClosed ?? false,
      reportId: input.previous?.id ?? null, revision: input.previous?.revision ?? 0,
      mailQueued: input.previous ? store.outbox().some(e => e.notification.originId === input.previous!.id) : false }));
  } finally { store.close(); }
}

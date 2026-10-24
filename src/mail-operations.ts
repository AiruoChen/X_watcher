import type { DeliveryResolution, RuntimeConfig } from './domain/model.js';
import { SqliteStore } from './adapters/storage/sqlite/store.js';
/** Local-only operations. No provider client is loaded and no message can be sent here. */
export function mailOperations(config: RuntimeConfig, command: string, args: readonly string[]): void {
  if (config.storage.kind !== 'sqlite') throw new Error('Mail operations require SQLite storage.');
  if (command === 'mail:status' ? args.length !== 1 : args.length !== 6)
    throw new Error('Usage: mail:status <notificationId> | mail:resolve <notificationId> <attemptId> <revision> <confirm_sent|confirm_not_sent_retry|abandon> <actor> <reason>');
  const store = new SqliteStore(config.storage.path);
  try {
    const id = args[0]!;
    if (command === 'mail:resolve') {
      const action = args[3]!;
      if (!['confirm_sent','confirm_not_sent_retry','abandon'].includes(action) || !/^\d+$/.test(args[2]!)) throw new Error('Invalid mail resolution arguments.');
      store.resolveDelivery({ notificationId: id, attemptId: args[1]!, expectedRevision: Number(args[2]),
        action: action as DeliveryResolution['action'], actor: args[4]!, reason: args[5]!, at: new Date().toISOString() });
    }
    const record = store.deliveryRecord(id); if (!record) throw new Error('Unknown notification.');
    console.log(JSON.stringify({ id, state: record.entry.state, revision: record.revision,
      attemptId: record.attempt?.id ?? null, attempts: record.attempt?.number ?? 0,
      provider: record.attempt?.binding?.provider ?? null, auditCount: store.mailAudits(id).length }));
  } finally { store.close(); }
}

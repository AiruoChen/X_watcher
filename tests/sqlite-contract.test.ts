import { after } from 'node:test';
import { temporaryStorage, cleanupStorage } from './helpers/storage.js';
import { join } from 'node:path';
import { SqliteStore } from '../src/adapters/storage/sqlite/store.js';
import { watchStoreContract } from './contracts/watch-store.contract.js';
const root = temporaryStorage();
const stores: SqliteStore[] = [];
watchStoreContract('SqliteStore', () => {
  const store = new SqliteStore(join(root, `${stores.length}.sqlite`), { create: true }); stores.push(store); return store;
});
after(() => { for (const store of stores) store.close(); cleanupStorage(root); });

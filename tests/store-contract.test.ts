import { MemoryStore } from '../src/adapters/storage/memory-store.js';
import { watchStoreContract } from './contracts/watch-store.contract.js';
watchStoreContract('MemoryStore', () => new MemoryStore());

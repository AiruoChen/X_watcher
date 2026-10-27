import { createHash } from 'node:crypto';
import type { ContentHasher } from '../domain/ports.js';
export class Sha256Hasher implements ContentHasher {
  hash(text: string): string { return createHash('sha256').update(text).digest('hex'); }
}

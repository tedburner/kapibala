import type { CanonicalMessage } from '../types/index.js';

export interface MessageStore {
  append(message: CanonicalMessage): Promise<void>;
  load(): Promise<CanonicalMessage[]>;
  clear(): Promise<void>;
}

export * from './jsonl.js';

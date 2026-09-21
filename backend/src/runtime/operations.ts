import { createHash } from 'node:crypto';
import type { Store } from '../store.ts';
import type { OperationAssociation } from '../business/service.ts';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .filter(([, v]) => v !== undefined).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export type Operation = { id: string; conversationId: string; sourceMessage: string; name: string; input: unknown;
  targetId: string; state: 'committed' | 'completed' | 'unknown'; result?: unknown };

// A committed record means the synchronous business transaction happened, not that HTTP succeeded.
// Only the original in-memory reservation may dispatch. Reading this ledger never replays it.
export class RuntimeOperations {
  readonly store: Store;
  constructor(store: Store) {
    this.store = store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS runtime_operations(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
      source_message TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS runtime_operations_source ON runtime_operations(conversation_id,source_message);`);
  }
  identity(conversationId: string, sourceMessage: string, name: string, input: unknown) {
    return createHash('sha256').update(JSON.stringify(canonical({ conversationId, sourceMessage, name, input }))).digest('hex');
  }
  read(id: string): Operation | undefined {
    const row = this.store.db.prepare('SELECT body FROM runtime_operations WHERE id=?').get(id);
    return row ? JSON.parse(String(row.body)) : undefined;
  }
  private insert(operation: Operation) {
    if (!this.store.db.isTransaction) throw new Error('operation_association_requires_transaction');
    this.store.db.prepare('INSERT INTO runtime_operations VALUES(?,?,?,?)')
      .run(operation.id, operation.conversationId, operation.sourceMessage, JSON.stringify(operation));
  }
  private saved(operation: Operation) {
    this.store.db.prepare('UPDATE runtime_operations SET body=? WHERE id=?').run(JSON.stringify(operation), operation.id);
  }
  begin(conversationId: string, sourceMessage: string, name: string, input: unknown, guard: () => void) {
    const id = this.identity(conversationId, sourceMessage, name, input);
    const base = { id, conversationId, sourceMessage, name, input: canonical(input) };
    const prior = () => { guard(); return this.read(id); };
    const associate: OperationAssociation = targetId => {
      guard(); this.insert({ ...base, targetId, state: 'committed' });
    };
    return {
      id,
      sync: <T>(work: () => { targetId: string; result: T }): Operation => {
        return this.store.transaction(() => {
          const existing = prior(); if (existing) return existing;
          const { targetId, result } = work();
          const record: Operation = { ...base, targetId, state: 'completed', result };
          this.insert(record); return record;
        });
      },
      async: async <T>(work: (association: OperationAssociation) => Promise<T>): Promise<Operation> => {
        const existing = prior(); if (existing) return existing;
        try {
          // work must use the BusinessService transaction hook, never an async Store.transaction callback.
          const result = await work(associate);
          const committed = this.read(id);
          if (!committed) throw new Error('business_operation_missing_association');
          const completed: Operation = { ...committed, state: 'completed', result };
          this.saved(completed); return completed;
        } catch (error) {
          const committed = this.read(id);
          if (committed) this.saved({ ...committed, state: 'unknown' });
          throw error;
        }
      },
    };
  }
}

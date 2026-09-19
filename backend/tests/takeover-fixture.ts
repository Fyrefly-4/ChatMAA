import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { Store } from '../src/store.ts';

// Offline fixture only, written before starting either owner of these databases.
export function seedUncertain(dataDir: string) {
  const store = new Store(resolve(dataDir, 'business.sqlite'));
  const params = { stage: '1-7' as const, count: 2, medicine: 0 as const, premium: 0 as const };
  store.prepare('history', params, 'offline_callback_replay');
  store.mark('history', { state: 'unknown', confirmed: 1, started_cycles: 2, unsettled_cycles: 1, reason: 'executor_restarted' });
  const snapshot = store.get('history')!.snapshot;
  store.db.close();
  const db = new DatabaseSync(resolve(dataDir, 'executor.sqlite'));
  db.exec('CREATE TABLE executions(id TEXT PRIMARY KEY, params TEXT NOT NULL, snapshot TEXT NOT NULL)');
  db.prepare('INSERT INTO executions VALUES(?,?,?)').run('history', JSON.stringify(params), snapshot);
  db.close();
}

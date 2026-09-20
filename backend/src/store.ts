import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import type { Snapshot, Update, TaskView, SyncStatus } from './task-contract.ts';
import type { AnyParams } from './execution-contract.ts';
import { uncertainEvidence } from './task-contract.ts';

// Adapted from prototypes/lifecycle/src/store.ts at 273055d: preserve transactional evidence projection.
export type Task = { id: string; params: string; snapshot: string; cursor: number; gap: number };

export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, params TEXT NOT NULL,
        snapshot TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0, gap INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS evidence(id TEXT NOT NULL, seq INTEGER NOT NULL,
        body TEXT NOT NULL, PRIMARY KEY(id, seq));
      CREATE TABLE IF NOT EXISTS gaps(id TEXT NOT NULL, after_seq INTEGER NOT NULL, through_seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS synchronization(id TEXT PRIMARY KEY, last_success REAL);`);
  }
  get(id: string) { return this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as Task | undefined; }
  all() { return this.db.prepare('SELECT * FROM tasks').all() as Task[]; }
  view(id: string, sync?: SyncStatus): TaskView | null {
    const row = this.get(id);
    const previous = this.db.prepare('SELECT last_success FROM synchronization WHERE id=?').get(id);
    return row ? { ...JSON.parse(row.snapshot), params: JSON.parse(row.params), cursor: row.cursor, gap: !!row.gap,
      sync: sync ?? { available: false, last_success_at: previous?.last_success ?? null, reason: 'not_synchronized' } } : null;
  }
  prepare(id: string, params: AnyParams, source: string) {
    const snapshot: Snapshot = { id, seq: 0, state: 'submitting', confirmed: 0,
      certainty: 'lower_bound', device: 'needs_check', reason: 'submission_not_confirmed',
      automation_stopped: false, started_cycles: 0, unsettled_cycles: 0, evidence_source: source };
    this.db.prepare('INSERT INTO tasks(id, params, snapshot) VALUES(?,?,?)').run(id, JSON.stringify(params), JSON.stringify(snapshot));
  }
  mark(id: string, changes: Partial<Snapshot>) {
    const row = this.get(id)!;
    this.db.prepare('UPDATE tasks SET snapshot=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(row.snapshot), ...changes }), id);
  }
  apply(id: string, update: Update) {
    const row = this.get(id)!;
    if (update.snapshot.seq < row.cursor) return;
    let cursor = row.cursor;
    let gap = !!row.gap;
    let conflict = JSON.parse(row.snapshot).evidence_conflict === true;
    if (update.snapshot.id !== id || update.events.some(e => e.id !== id)) throw new Error('evidence identity mismatch');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const event of update.events) {
        const previous = this.db.prepare('SELECT body FROM evidence WHERE id=? AND seq=?').get(id, event.seq);
        if (previous && !isDeepStrictEqual(JSON.parse(String(previous.body)), event)) conflict = true;
        if (event.seq <= cursor) continue;
        if (event.seq !== cursor + 1) gap = true;
        this.db.prepare('INSERT OR IGNORE INTO evidence VALUES(?,?,?)').run(id, event.seq, JSON.stringify(event));
        cursor = event.seq;
      }
      if (cursor < update.snapshot.seq || conflict) gap = true;
      if (gap && !row.gap) {
        this.db.prepare('INSERT INTO gaps VALUES(?,?,?)').run(id, row.cursor, update.snapshot.seq);
      }
      // 快照包含绝对已确认完成量；缺口保留，不把最后值当作完整结果。
      const snapshot: Snapshot = conflict
        ? uncertainEvidence({ ...JSON.parse(row.snapshot), evidence_conflict: true, state: 'unknown',
          device: 'needs_check', reason: 'evidence_conflict' }, 'evidence_conflict', true)
        : gap ? uncertainEvidence(update.snapshot, 'evidence_gap') : { ...update.snapshot };
      // 已发出的停止意图属于 TS。停止前发起的轮询可能晚到，不能把界面退回“运行中”。
      if (JSON.parse(row.snapshot).stop_requested) {
        snapshot.stop_requested = true;
        if (['accepted', 'running', 'submitting'].includes(snapshot.state)) {
          snapshot.state = 'stopping';
          snapshot.reason = 'stop_requested';
        }
      }
      this.db.prepare('UPDATE tasks SET snapshot=?, cursor=?, gap=? WHERE id=?')
        .run(JSON.stringify(snapshot), Math.max(cursor, update.snapshot.seq), gap ? 1 : 0, id);
      this.db.prepare('INSERT INTO synchronization VALUES(?,?) ON CONFLICT(id) DO UPDATE SET last_success=excluded.last_success')
        .run(id, Date.now() / 1000);
      this.db.exec('COMMIT');
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

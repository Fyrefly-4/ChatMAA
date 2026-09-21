import { randomUUID } from 'node:crypto';
import type { BusinessService } from '../business/service.ts';
import type { Store } from '../store.ts';
import { TaskError } from '../task-contract.ts';

export type Turn = {
  id: string; conversationId: string; sourceMessage: string; generation: number;
  sourceMessages?: string[];
  state: 'processing' | 'completed' | 'failed' | 'interrupted';
  reason: string | null; createdAt: string; finishedAt: string | null;
};
export type Activity = { sequence: number; turnId: string; kind: string; data: unknown };

// Runtime records share the business database. They never own execution facts.
export class RuntimeRecords {
  readonly store: Store;
  constructor(store: Store) {
    this.store = store;
    store.transaction(() => {
      store.db.exec(`CREATE TABLE IF NOT EXISTS runtime_turns(
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, source_message TEXT NOT NULL UNIQUE,
        generation INTEGER NOT NULL, body TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS runtime_turns_conversation ON runtime_turns(conversation_id, generation);
        CREATE TABLE IF NOT EXISTS runtime_heads(conversation_id TEXT PRIMARY KEY, generation INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS runtime_activities(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, turn_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS runtime_activities_turn ON runtime_activities(turn_id, sequence);`);
    });
  }
  read(id: string): Turn | undefined {
    const row = this.store.db.prepare('SELECT body FROM runtime_turns WHERE id=?').get(id);
    return row ? JSON.parse(String(row.body)) : undefined;
  }
  private save(turn: Turn) {
    this.store.db.prepare('UPDATE runtime_turns SET body=? WHERE id=?').run(JSON.stringify(turn), turn.id);
  }
  activity(turnId: string, kind: string, data: unknown = null) {
    if (!this.read(turnId)) throw new TaskError(404, 'unknown_turn');
    const result = this.store.db.prepare('INSERT INTO runtime_activities(turn_id,kind,data) VALUES(?,?,?)')
      .run(turnId, kind, JSON.stringify(data));
    return Number(result.lastInsertRowid);
  }
  activities(turnId: string, after = 0, limit = 100): Activity[] {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new TaskError(422, 'invalid_activity_page');
    if (!this.read(turnId)) throw new TaskError(404, 'unknown_turn');
    return this.store.db.prepare('SELECT sequence,kind,data FROM runtime_activities WHERE turn_id=? AND sequence>? ORDER BY sequence LIMIT ?')
      .all(turnId, after, limit).map(row => ({ sequence: Number(row.sequence), turnId,
        kind: String(row.kind), data: JSON.parse(String(row.data)) }));
  }
  current(turn: Turn): boolean {
    const head = this.store.db.prepare('SELECT generation FROM runtime_heads WHERE conversation_id=?').get(turn.conversationId);
    return head?.generation === turn.generation && this.read(turn.id)?.state === 'processing';
  }
  assertCurrent(turn: Turn) {
    if (!this.current(turn)) throw new TaskError(409, 'turn_not_current');
  }
  accept(business: BusinessService, conversationId: string, messageId: string, text: string): { turn: Turn; duplicate: boolean; interrupted: string[] } {
    if (business.tasks.store !== this.store) throw new Error('runtime_business_store_mismatch');
    return this.store.transaction(() => {
      // The business service checks identity/content conflicts even for transport retries.
      business.appendMessage(conversationId, messageId, 'user', text);
      const existing = this.store.db.prepare('SELECT body FROM runtime_turns WHERE source_message=?').get(messageId);
      if (existing) return { turn: JSON.parse(String(existing.body)) as Turn, duplicate: true, interrupted: [] };
      const previous = this.store.db.prepare('SELECT generation FROM runtime_heads WHERE conversation_id=?').get(conversationId);
      const generation = Number(previous?.generation ?? 0) + 1;
      const completed = this.store.db.prepare("SELECT MAX(generation) AS generation FROM runtime_turns WHERE conversation_id=? AND json_extract(body,'$.state')='completed'").get(conversationId);
      const sources = this.store.db.prepare('SELECT source_message FROM runtime_turns WHERE conversation_id=? AND generation>? ORDER BY generation')
        .all(conversationId, Number(completed?.generation ?? 0)).map(row => String(row.source_message));
      const interrupted: string[] = [];
      for (const row of this.store.db.prepare("SELECT body FROM runtime_turns WHERE conversation_id=? AND json_extract(body,'$.state')='processing'").all(conversationId)) {
        const turn: Turn = JSON.parse(String(row.body));
        this.finish(turn.id, 'interrupted', 'new_message'); interrupted.push(turn.id);
      }
      this.store.db.prepare('INSERT INTO runtime_heads VALUES(?,?) ON CONFLICT(conversation_id) DO UPDATE SET generation=excluded.generation')
        .run(conversationId, generation);
      const turn: Turn = { id: randomUUID(), conversationId, sourceMessage: messageId, generation,
        sourceMessages: [...new Set([...sources, messageId])],
        state: 'processing', reason: null, createdAt: new Date().toISOString(), finishedAt: null };
      this.store.db.prepare('INSERT INTO runtime_turns VALUES(?,?,?,?,?)')
        .run(turn.id, conversationId, messageId, generation, JSON.stringify(turn));
      this.activity(turn.id, 'accepted', { sourceMessage: messageId });
      return { turn, duplicate: false, interrupted };
    });
  }
  finish(id: string, state: Exclude<Turn['state'], 'processing'>, reason: string | null = null) {
    return this.store.transaction(() => {
      const turn = this.read(id);
      if (!turn) throw new TaskError(404, 'unknown_turn');
      if (turn.state !== 'processing') return turn;
      const next = { ...turn, state, reason, finishedAt: new Date().toISOString() };
      this.save(next); this.activity(id, state, { reason }); return next;
    });
  }
  publish(business: BusinessService, turn: Turn, text: string) {
    if (business.tasks.store !== this.store) throw new Error('runtime_business_store_mismatch');
    return this.store.transaction(() => {
      this.assertCurrent(turn);
      const message = business.appendMessage(turn.conversationId, `reply-${turn.id}`, 'assistant', text, turn.id);
      this.activity(turn.id, 'message', { messageId: message.id });
      this.finish(turn.id, 'completed'); return message;
    });
  }
  // Call once when the owning application starts, never on a read/reconnect.
  recover() {
    return this.store.transaction(() => {
      const rows = this.store.db.prepare("SELECT id FROM runtime_turns WHERE json_extract(body,'$.state')='processing'").all();
      for (const row of rows) this.finish(String(row.id), 'interrupted', 'host_restarted');
      return rows.length;
    });
  }
}

import type { DatabaseSync } from 'node:sqlite';
import type { Permission } from './policy.ts';

export type RequestRecord = {
  requestId: string; operationId: string; original: string; targetId?: string;
  permission: Permission; policyVersion: string; provider: string; model: string;
  createdAt: string; status: 'running' | 'finished' | 'failed' | 'interrupted';
  mutation?: { tool: string; input: unknown }; summary?: string; reply?: string; error?: string;
};
export type AgentEvent = { kind: 'request' | 'model_tools' | 'tool_call' | 'summary' | 'tool_result' | 'reply' | 'error'; data: unknown };
export type EventSink = (event: AgentEvent) => Promise<void>;

export class AgentRecords {
  readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS agent_requests(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL, body TEXT NOT NULL);`);
  }
  get(id: string): RequestRecord | undefined {
    const row = this.db.prepare('SELECT body FROM agent_requests WHERE id=?').get(id);
    return row ? JSON.parse(String(row.body)) : undefined;
  }
  create(record: RequestRecord) {
    this.db.prepare('INSERT INTO agent_requests VALUES(?,?)').run(record.requestId, JSON.stringify(record));
  }
  save(record: RequestRecord) {
    this.db.prepare('UPDATE agent_requests SET body=? WHERE id=?').run(JSON.stringify(record), record.requestId);
  }
  event(id: string, event: AgentEvent) {
    this.db.prepare('INSERT INTO agent_events(request_id,body) VALUES(?,?)').run(id, JSON.stringify(event));
  }
  events(id: string): AgentEvent[] {
    return this.db.prepare('SELECT body FROM agent_events WHERE request_id=? ORDER BY seq').all(id)
      .map(row => JSON.parse(String(row.body)));
  }
}

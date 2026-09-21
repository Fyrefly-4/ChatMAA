import type { Store } from '../store.ts';
import type { GoalDraft, Goal, Amount, GoalResult } from './goals.ts';
import type { CatalogSnapshot } from './catalog.ts';

export type Conversation = { id: string; conversationId: string; title: string; currentRequest: string | null; currentPlan: string | null; createdAt: string };
export type Message = { id: string; conversationId: string; role: 'user' | 'assistant' | 'system'; text: string; reference?: string; createdAt: string };
export type Request = { id: string; conversationId: string; revision: number; goal: GoalDraft; sourceMessage: string;
  intent: 'execute' | 'inspect_inventory'; scanRevision: number | null;
  state: 'active' | 'cancelled' | 'superseded' | 'executing' | 'completed'; waiting: string[];
  scanTask: string | null; previousTasks: string[]; adjustment: 'total' | 'additional' | null; observedId: string | null };
export type Plan = { id: string; conversationId: string; requestId: string; revision: number; goal: Goal;
  quantity: number; stage: string; catalogVersion: string; catalogBasis: string; selection: string; explanation: string;
  estimate: unknown; observationId: string | null; initialInventory: number | null; prior: Amount;
  resources: { medicine: 0; premium: 0; expiringMedicine: 0 };
  endConditions: string[]; limitations: string[];
  previousTasks: string[]; state: 'unpresented' | 'presented' | 'superseded' | 'cancelled' | 'started' | 'stale';
  taskId: string | null; createdAt: string };
export type Presentation = { id: string; conversationId: string; planId: string; createdAt: string; lastMessageId?: string | null };
export type Confirmation = { id: string; conversationId: string; planId: string; presentationId: string; source: 'button' | 'message'; sourceMessage: string | null; taskId: string };
export type TaskLink = { id: string; conversationId: string; requestId: string; requestRevision: number; planId: string | null;
  purpose: 'inventory' | 'fight'; result: GoalResult | null; resultDigest: string | null; completedChangeSequence?: number };
export type Observation = { id: string; conversationId: string; taskId: string; items: Record<string, number>; observedAt: number;
  reliable: boolean; changeSequence: number; evidenceSequence: number };
export type InventoryChange = { id: string; conversationId: string; sequence: number; taskId: string | null;
  itemIds: string[] | null; reason: string; observedAt: number };
export type Continuation = { id: string; conversationId: string; requestId: string; revision: number; taskId: string | null;
  state: 'pending' | 'processing' | 'completed' | 'failed' | 'interrupted' | 'obsolete'; reason: string; token: string | null };
type SavedCatalog = { id: string; conversationId: string; snapshot: CatalogSnapshot };
export type Records = { conversations: Conversation; messages: Message; execution_requests: Request; plan_versions: Plan;
  plan_presentations: Presentation; confirmations: Confirmation; task_links: TaskLink; observations: Observation;
  inventory_changes: InventoryChange; continuations: Continuation; catalogs: SavedCatalog };
const tables = ['conversations', 'messages', 'execution_requests', 'plan_versions', 'plan_presentations', 'confirmations',
  'task_links', 'observations', 'inventory_changes', 'continuations', 'catalogs'] as const;
export class BusinessRecords {
  readonly store: Store;
  constructor(store: Store) {
    this.store = store;
    store.transaction(() => {
      store.db.exec('CREATE TABLE IF NOT EXISTS business_schema(version INTEGER NOT NULL)');
      store.db.exec('CREATE TABLE IF NOT EXISTS business_metadata(id TEXT PRIMARY KEY,value TEXT NOT NULL)');
      const row = store.db.prepare('SELECT version FROM business_schema').get();
      if (row && row.version !== 1) throw new Error('不支持的业务数据库版本');
      for (const table of tables) store.db.exec(`CREATE TABLE IF NOT EXISTS ${table}(
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, body TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS ${table}_conversation ON ${table}(conversation_id);`);
      if (!row) store.db.exec('INSERT INTO business_schema VALUES(1)');
    });
  }
  read<K extends keyof Records>(table: K, id: string): Records[K] | undefined {
    const row = this.store.db.prepare(`SELECT body FROM ${table} WHERE id=?`).get(id);
    return row ? JSON.parse(String(row.body)) : undefined;
  }
  list<K extends keyof Records>(table: K, conversationId?: string): Records[K][] {
    const statement = this.store.db.prepare(`SELECT body FROM ${table}${conversationId === undefined ? '' : ' WHERE conversation_id=?'} ORDER BY rowid`);
    return (conversationId === undefined ? statement.all() : statement.all(conversationId)).map(r => JSON.parse(String(r.body)));
  }
  currentRequests(taskIds?: string[], inventoryChanged = false): Request[] {
    const scope = taskIds === undefined ? '' : ` AND (
      json_extract(r.body,'$.scanTask') IN (SELECT value FROM json_each(?)) OR
      json_extract(r.body,'$.observedId') IN (SELECT value FROM json_each(?)) OR
      EXISTS (SELECT 1 FROM json_each(r.body,'$.previousTasks') WHERE value IN (SELECT value FROM json_each(?))) OR
      (? AND json_extract(r.body,'$.goal.kind')='inventory'))`;
    const query = this.store.db.prepare(`SELECT r.body FROM execution_requests r JOIN conversations c
      ON json_extract(c.body,'$.currentRequest')=r.id WHERE json_extract(r.body,'$.state') IN ('active','executing')${scope}`);
    const ids = JSON.stringify(taskIds);
    return (taskIds === undefined ? query.all() : query.all(ids!, ids!, ids!, Number(inventoryChanged))).map(r => JSON.parse(String(r.body)));
  }
  affectedLinks(taskIds: string[], inventoryChanged: boolean): TaskLink[] {
    const ids = JSON.stringify(taskIds);
    return this.store.db.prepare(`SELECT l.body FROM task_links l LEFT JOIN plan_versions p ON p.id=json_extract(l.body,'$.planId')
      WHERE l.id IN (SELECT value FROM json_each(?)) OR json_extract(p.body,'$.observationId') IN (SELECT value FROM json_each(?)) OR
      EXISTS (SELECT 1 FROM json_each(p.body,'$.previousTasks') WHERE value IN (SELECT value FROM json_each(?))) OR
      (? AND json_extract(p.body,'$.goal.kind')='inventory' AND json_extract(l.body,'$.completedChangeSequence') IS NULL)`)
      .all(ids, ids, ids, Number(inventoryChanged)).map(r => JSON.parse(String(r.body)));
  }
  pendingContinuations(): Continuation[] {
    return this.store.db.prepare("SELECT body FROM continuations WHERE json_extract(body,'$.state')='pending' ORDER BY rowid")
      .all().map(r => JSON.parse(String(r.body)));
  }
  latestMessageId(conversationId: string): string | null {
    const row = this.store.db.prepare('SELECT id FROM messages WHERE conversation_id=? ORDER BY rowid DESC LIMIT 1').get(conversationId);
    return row ? String(row.id) : null;
  }
  messageFollows(id: string, boundary: string | null): boolean {
    return !!this.store.db.prepare(`SELECT 1 FROM messages WHERE id=? AND
      (? IS NULL OR rowid > (SELECT rowid FROM messages WHERE id=?))`).get(id, boundary, boundary);
  }
  messageConfirmedElsewhere(messageId: string, planId: string): boolean {
    return !!this.store.db.prepare(`SELECT 1 FROM confirmations WHERE
      json_extract(body,'$.sourceMessage')=? AND json_extract(body,'$.planId')<>? LIMIT 1`).get(messageId, planId);
  }
  requestContinuations(requestId: string): Continuation[] {
    return this.store.db.prepare("SELECT body FROM continuations WHERE json_extract(body,'$.requestId')=? AND json_extract(body,'$.state') IN ('pending','processing')")
      .all(requestId).map(r => JSON.parse(String(r.body)));
  }
  insert<K extends keyof Records>(table: K, record: Records[K]) {
    this.store.db.prepare(`INSERT INTO ${table}(id,conversation_id,body) VALUES(?,?,?)`).run(record.id, record.conversationId, JSON.stringify(record));
  }
  save<K extends keyof Records>(table: K, record: Records[K]) {
    const result = this.store.db.prepare(`UPDATE ${table} SET body=? WHERE id=? AND conversation_id=?`).run(JSON.stringify(record), record.id, record.conversationId);
    if (result.changes !== 1) throw new Error('业务记录不存在或归属不一致');
  }
}

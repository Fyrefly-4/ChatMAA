import { TaskError, taskId, blocksExecution } from '../task-contract.ts';
import type { Evidence } from '../task-contract.ts';
import type { BusinessService } from '../business/service.ts';
import type { Message } from '../business/records.ts';
import type { RuntimeService } from '../runtime/service.ts';
import type { Turn } from '../runtime/records.ts';

export function pageNumber(value: string | undefined, fallback = 0) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new TaskError(422, 'invalid_cursor');
  return Number(value);
}

// Read projections only. BusinessService remains the authority for every mutation.
export class MvpQueries {
  readonly business: BusinessService;
  readonly runtime: RuntimeService;
  constructor(business: BusinessService, runtime: RuntimeService) { this.business = business; this.runtime = runtime; }
  conversation(id: string) {
    const b = this.business;
    const conversation = b.records.read('conversations', taskId(id));
    if (!conversation) throw new TaskError(404, 'unknown_conversation');
    return { ...conversation,
      request: conversation.currentRequest ? b.request(conversation.currentRequest) : null,
      plan: conversation.currentPlan ? this.plan(conversation.currentPlan) : null,
      activeTasks: b.tasks.list().filter(blocksExecution)
        .filter(t => b.records.read('task_links', t.id)?.conversationId === id).map(t => this.task(t.id)),
    };
  }
  plan(id: string) {
    const b = this.business; const plan = b.plan(taskId(id));
    const catalog = b.records.read('catalogs', plan.catalogVersion)?.snapshot;
    const request = b.request(plan.requestId);
    return { ...plan, presentation: b.records.latestPresentation(id),
      adjustment: request.adjustment,
      relatedTasks: request.previousTasks,
      itemName: plan.goal.itemId ? catalog?.items[plan.goal.itemId]?.name ?? plan.goal.itemId : null,
      sources: catalog?.sources ?? {},
      observation: plan.observationId ? b.records.read('observations', plan.observationId) : null,
    };
  }
  task(id: string) {
    const task = this.business.task(id);
    return { ...task, plan: task.planId ? this.plan(task.planId) : null };
  }
  messages(id: string, before?: string, after?: string) {
    this.conversationExists(id);
    if (before !== undefined && after !== undefined) throw new TaskError(422, 'invalid_history_cursor');
    const db = this.business.tasks.store.db;
    const cursor = before ?? after;
    const row = cursor === undefined ? undefined : db.prepare('SELECT rowid FROM messages WHERE id=? AND conversation_id=?').get(cursor, id);
    if (cursor !== undefined && !row) throw new TaskError(422, 'invalid_history_cursor');
    const forward = after !== undefined;
    const rows = db.prepare(`SELECT body FROM messages WHERE conversation_id=?
      AND (? IS NULL OR rowid ${forward ? '>' : '<'} ?) ORDER BY rowid ${forward ? 'ASC' : 'DESC'} LIMIT 21`)
      .all(id, row?.rowid ?? null, row?.rowid ?? null);
    const messages = rows.slice(0, 20).map(r => JSON.parse(String(r.body)) as Message);
    if (!forward) messages.reverse();
    const references = [...new Set(messages.flatMap(m => m.reference ? [m.reference] : []))];
    return { messages, hasMore: rows.length > 20,
      nextBefore: !forward && rows.length > 20 ? messages[0].id : null,
      nextAfter: messages.at(-1)?.id ?? after ?? null,
      plans: references.filter(ref => this.business.records.read('plan_versions', ref)?.conversationId === id).map(ref => this.plan(ref)),
      tasks: references.filter(ref => this.business.records.read('task_links', ref)?.conversationId === id).map(ref => this.task(ref)),
    };
  }
  turns(id: string, before?: number, after?: number) {
    this.conversationExists(id);
    if (before !== undefined && after !== undefined) throw new TaskError(422, 'invalid_cursor');
    const forward = after !== undefined;
    const rows = this.business.tasks.store.db.prepare(`SELECT body FROM runtime_turns WHERE conversation_id=?
      AND (? IS NULL OR generation ${forward ? '>' : '<'} ?) ORDER BY generation ${forward ? 'ASC' : 'DESC'} LIMIT 21`)
      .all(id, before ?? after ?? null, before ?? after ?? null);
    const turns = rows.slice(0, 20).map(r => JSON.parse(String(r.body)) as Turn);
    if (!forward) turns.reverse();
    return { turns, hasMore: rows.length > 20,
      nextBefore: !forward && rows.length > 20 ? turns[0].generation : null,
      nextAfter: turns.at(-1)?.generation ?? after ?? 0 };
  }
  message(id: string, messageId: string) {
    this.conversationExists(id);
    const message = this.business.records.read('messages', taskId(messageId));
    if (!message || message.conversationId !== id) throw new TaskError(404, 'unknown_message');
    const row = this.business.tasks.store.db.prepare('SELECT body FROM runtime_turns WHERE conversation_id=? AND source_message=?').get(id, messageId);
    return { message, turn: row ? JSON.parse(String(row.body)) as Turn : null };
  }
  evidence(id: string, after: number) {
    this.business.tasks.get(taskId(id));
    if (!Number.isSafeInteger(after) || after < 0) throw new TaskError(422, 'invalid_cursor');
    const rows = this.business.tasks.store.db.prepare('SELECT body FROM evidence WHERE id=? AND seq>? ORDER BY seq LIMIT 101').all(id, after);
    const events = rows.slice(0, 100).map(row => JSON.parse(String(row.body)) as Evidence);
    return { events, hasMore: rows.length > 100, nextAfter: events.at(-1)?.seq ?? after };
  }
  private conversationExists(id: string) {
    if (!this.business.records.read('conversations', taskId(id))) throw new TaskError(404, 'unknown_conversation');
  }
}

export type MvpConversation = ReturnType<MvpQueries['conversation']>;
export type PlanView = ReturnType<MvpQueries['plan']>;
export type MessagePage = ReturnType<MvpQueries['messages']>;
export type TurnPage = ReturnType<MvpQueries['turns']>;
export type EvidencePage = ReturnType<MvpQueries['evidence']>;
export type BusinessTask = ReturnType<MvpQueries['task']>;

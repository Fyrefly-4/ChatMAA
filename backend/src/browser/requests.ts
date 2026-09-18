import { randomUUID } from 'node:crypto';
import { AgentRequests } from '../agent/requests.ts';
import { TaskError, taskId } from '../task-contract.ts';
import type { LanguageModel } from 'ai';
import type { TaskService } from '../task-service.ts';

export type BrowserInput = { requestId: string; original: string; targetId?: string };
export type Receipt = { operationId: string; receiptId: string };

function input(value: unknown): BrowserInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TaskError(422, 'invalid_request');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !['requestId', 'original', 'targetId'].includes(k)) ||
      typeof v.original !== 'string' || !v.original.trim() || v.original.length > 8000) {
    throw new TaskError(422, 'invalid_request');
  }
  return { requestId: taskId(v.requestId), original: v.original,
    ...(v.targetId === undefined ? {} : { targetId: taskId(v.targetId) }) };
}

/** One application instance; HTTP reads never create another AgentRequests. */
export class BrowserRequests {
  readonly agent: AgentRequests | undefined;
  private active: Promise<unknown> | undefined;
  private pending = new Map<string, Receipt & { release: () => void }>();
  private acknowledged = new Map<string, Receipt>();
  closing = false;
  constructor(tasks: TaskService, model?: LanguageModel, privateOptions: { timeoutMs?: number } = {}) {
    this.agent = model ? new AgentRequests(tasks, model) : undefined;
    this.options = privateOptions;
  }
  private readonly options: { timeoutMs?: number };
  get busy() { return !!this.active; }
  read(id: string) {
    taskId(id);
    if (!this.agent) throw new TaskError(503, 'model_unavailable');
    if (!this.agent.records.get(id)) throw new TaskError(404, 'unknown_request');
    const pending = this.pending.get(id);
    return { ...this.agent.read(id), pendingSummary: pending
      ? { operationId: pending.operationId, receiptId: pending.receiptId } : null };
  }
  submit(value: unknown) {
    const v = input(value);
    if (this.closing) throw new TaskError(503, 'service_closing');
    const agent = this.agent;
    if (!agent) throw new TaskError(503, 'model_unavailable');
    const old = agent.records.get(v.requestId);
    if (old) {
      if (old.original !== v.original || old.targetId !== v.targetId) throw new TaskError(409, 'request_id_conflict');
      return this.read(v.requestId);
    }
    if (this.active) throw new TaskError(409, 'request_busy');
    // handle reserves its record synchronously, before its first output await.
    this.active = agent.handle(v, async event => {
      if (event.kind !== 'summary') return;
      const record = agent.records.get(v.requestId)!;
      await new Promise<void>(release => {
        this.pending.set(v.requestId, { operationId: record.operationId, receiptId: randomUUID(), release });
      });
    }, this.options).finally(() => {
      this.pending.delete(v.requestId);
      this.acknowledged.delete(v.requestId);
      this.active = undefined;
    });
    // Observe rejection even if the HTTP caller disappears.
    void this.active.catch(() => {});
    return this.read(v.requestId);
  }
  acknowledge(id: string, value: unknown) {
    const view = this.read(id);
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).sort().join() !== 'operationId,receiptId') throw new TaskError(422, 'invalid_receipt');
    const v = value as Receipt;
    const pending = this.pending.get(id);
    const expected = pending ?? this.acknowledged.get(id);
    if (this.closing || view.record.status !== 'running' || !expected ||
        expected.operationId !== v.operationId || expected.receiptId !== v.receiptId) {
      throw new TaskError(409, 'summary_not_pending');
    }
    if (pending) {
      this.acknowledged.set(id, { operationId: v.operationId, receiptId: v.receiptId });
      this.pending.delete(id);
      pending.release();
    }
    return { displayed: true };
  }
  async close() {
    this.closing = true;
    this.agent?.cancelAll();
    await this.active;
  }
}

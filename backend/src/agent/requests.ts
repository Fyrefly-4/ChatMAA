import { randomUUID } from 'node:crypto';
import type { LanguageModel } from 'ai';
import { taskId } from '../task-contract.ts';
import type { TaskService } from '../task-service.ts';
import { authorize, POLICY_VERSION } from './policy.ts';
import { AgentRecords } from './records.ts';
import type { EventSink, RequestRecord } from './records.ts';
import { MODEL_IDENTITY } from './provider.ts';
import { boundTools } from './tools.ts';
import { runModel } from './runtime.ts';
import { waitForOutput } from './wait.ts';

export class AgentRequests {
  readonly records: AgentRecords;
  readonly tasks: TaskService;
  readonly model: LanguageModel;
  private active = new Map<string, AbortController>();
  constructor(tasks: TaskService, model: LanguageModel) {
    this.tasks = tasks; this.model = model; this.records = new AgentRecords(tasks.store.db);
  }
  read(requestId: string) {
    const record = this.records.get(taskId(requestId));
    if (!record) throw new Error('unknown_request');
    const id = record.permission.action === 'submit' ? record.operationId : record.targetId;
    const task = id && this.tasks.store.get(id) ? this.tasks.get(id) : null;
    return { record: { ...record, status: record.status === 'running' && !this.active.has(requestId)
      ? 'interrupted' as const : record.status }, events: this.records.events(requestId), task };
  }
  cancel(requestId: string) { this.active.get(requestId)?.abort(); }
  cancelAll() { for (const controller of this.active.values()) controller.abort(); }
  async handle(input: { requestId: string; original: string; targetId?: string }, sink: EventSink,
    options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
    taskId(input.requestId);
    if (input.targetId) taskId(input.targetId);
    if (typeof input.original !== 'string' || !input.original.trim() || input.original.length > 8000) throw new Error('invalid_original');
    const old = this.records.get(input.requestId);
    if (old) {
      if (old.original !== input.original || old.targetId !== input.targetId) throw new Error('request_id_conflict');
      return this.read(input.requestId); // 传输重试和重启都只读取，不重新运行模型或执行。
    }
    const record: RequestRecord = { ...input, operationId: randomUUID(),
      permission: authorize(input.original, input.targetId), policyVersion: POLICY_VERSION,
      ...MODEL_IDENTITY, createdAt: new Date().toISOString(), status: 'running' };
    this.records.create(record);
    const controller = new AbortController();
    this.active.set(record.requestId, controller);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(options.timeoutMs ?? 60000),
      ...(options.signal ? [options.signal] : [])]);
    let open = true;
    let toolsOpen = true;
    const emit: EventSink = async event => {
      try {
        this.records.event(record.requestId, event);
        await waitForOutput(() => sink(event), signal);
      } catch {
        record.error = 'trace_or_display_incomplete';
        controller.abort();
        throw new Error('trace_or_display_incomplete');
      }
    };
    try {
      await emit({ kind: 'request', data: record });
      signal.throwIfAborted();
      const tools = boundTools({ record, records: this.records, tasks: this.tasks, signal, emit, isOpen: () => open && toolsOpen });
      // 即使 provider 忽略 abort，handle 也有界退出；迟到的工具回调受 signal/open 阻止。
      const reply = await new Promise<string>((resolve, reject) => {
        const abort = () => reject(new Error('model_cancelled_or_timed_out'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) { abort(); return; }
        runModel(this.model, input.original, tools, signal, () => { toolsOpen = false; }, emit).then(resolve, reject)
          .finally(() => signal.removeEventListener('abort', abort));
      });
      record.reply = reply; record.status = 'finished';
      this.records.save(record);
      await emit({ kind: 'reply', data: { text: reply, operationId: record.operationId,
        submitted: !!this.tasks.store.get(record.operationId) } });
    } catch {
      record.status = 'failed'; record.error ??= signal.aborted ? 'model_cancelled_or_timed_out' : 'model_or_trace_failed';
      try { this.records.save(record); await emit({ kind: 'error', data: { code: record.error, operationId: record.operationId } }); }
      catch { /* 执行事实仍由独立任务入口读取；不因追踪失败重发。 */ }
    } finally {
      open = false; this.active.delete(record.requestId);
    }
    try { return this.read(record.requestId); }
    catch { return { record, events: [], task: null, traceUnavailable: true }; }
  }
}

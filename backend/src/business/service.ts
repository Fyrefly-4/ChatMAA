import { newRequest, transitionRequest, canRevise, awaitsScan } from './request-lifecycle.ts';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { TaskError, taskId, blocksExecution } from '../task-contract.ts';
import type { TaskView } from '../task-contract.ts';
import { BusinessBasis } from './basis.ts';
import { FactProjection } from './projection.ts';
import type { ProjectionEffect } from './projection.ts';
import { FollowupRunner } from './followups.ts';
import type { TaskService } from '../task-service.ts';
import { Catalog, digest } from './catalog.ts';
import { BusinessRecords } from './records.ts';
import type { Request, Plan, Message, Continuation } from './records.ts';
import { goalDraft, missingGoal, amount, sumAmounts, executionParams, resultText } from './goals.ts';
import type { Goal, Amount } from './goals.ts';

const now = () => new Date().toISOString();
const fail = (code: string, status = 409): never => { throw new TaskError(status, code); };
export type OperationAssociation = (id: string) => void;
function associate(callback: OperationAssociation | undefined, id: string) {
  const result: unknown = callback?.(id);
  if (result && typeof (result as PromiseLike<unknown>).then === 'function') throw new Error('association_must_be_synchronous');
}
export type FollowUp = { record: Continuation; request: Request; conversation: ReturnType<BusinessService['conversation']>; task: TaskView | null; signal: AbortSignal };
export class BusinessService {
  readonly tasks: TaskService;
  readonly records: BusinessRecords;
  catalog: Catalog;
  private reconciling = false;
  private readonly basis: BusinessBasis;
  private readonly projection: FactProjection;
  private readonly followups: FollowupRunner<FollowUp>;
  private pendingTasks = new Set<string>();
  private fullProjectionPending = false;
  private inventoryProjectionPending = false;
  private catalogProjectionPending = false;
  private projectionFailure: string | null = null;
  private closing = false;
  private retiring = false;
  private followupsClosing?: Promise<void>;
  constructor(tasks: TaskService, catalog?: Catalog) {
    this.tasks = tasks; this.records = new BusinessRecords(tasks.store);
    const active = tasks.store.db.prepare("SELECT value FROM business_metadata WHERE id='catalog'").get();
    const saved = active ? this.records.read('catalogs', String(active.value)) : null;
    if (active && !saved) throw new Error('当前资料版本记录缺失');
    this.catalog = catalog ?? (saved ? new Catalog(saved.snapshot) : Catalog.bundled());
    this.transaction(() => { this.retainCatalog(this.catalog); this.saveCatalogSelection(this.catalog); });
    this.basis = new BusinessBasis(this.records, tasks, () => this.catalog);
    this.projection = new FactProjection(this.records, tasks, this.basis);
    this.followups = new FollowupRunner(this.records, (record, signal) => {
      this.current(record.requestId, record.revision);
      if (this.closing || this.retiring || this.projectionFailure) return fail('business_unavailable', 503);
      return { record, request: this.request(record.requestId), conversation: this.conversation(record.conversationId),
        task: record.taskId ? this.tasks.get(record.taskId) : null, signal };
    }, () => { this.projectionFailure = 'followup_storage_failed'; });
    tasks.onSynchronized = id => this.reconcile({ taskIds: [id] });
    this.reconcile();
  }
  private transaction<T>(work: () => T): T {
    if (this.closing || this.tasks.storageFailed || ((this.retiring || this.projectionFailure) && !this.reconciling)) return fail('business_unavailable', 503);
    return this.tasks.store.transaction(work);
  }
  private retainCatalog(catalog: Catalog) {
    if (!this.records.read('catalogs', catalog.snapshot.version)) this.records.insert('catalogs', {
      id: catalog.snapshot.version, conversationId: '', snapshot: catalog.snapshot });
  }
  private saveCatalogSelection(catalog: Catalog) {
    this.tasks.store.db.prepare("INSERT INTO business_metadata(id,value) VALUES('catalog',?) ON CONFLICT(id) DO UPDATE SET value=excluded.value")
      .run(catalog.snapshot.version);
  }
  activateCatalog(snapshot: unknown) {
    const next = new Catalog(snapshot);
    this.transaction(() => { this.retainCatalog(next); this.saveCatalogSelection(next); });
    this.catalog = next;
    this.reconcile({ taskIds: [], catalogChanged: true }); return { version: next.snapshot.version, coverage: next.snapshot.coverage };
  }
  createConversation(id: string, title: string) {
    taskId(id); if (typeof title !== 'string' || !title.trim() || title.length > 200) return fail('invalid_title', 422);
    const existing = this.records.read('conversations', id);
    if (existing) { if (existing.title !== title) return fail('id_parameter_conflict'); return existing; }
    const value = { id, conversationId: id, title, currentRequest: null, currentPlan: null, createdAt: now() };
    this.transaction(() => this.records.insert('conversations', value)); return value;
  }
  conversation(id: string) {
    const conversation = this.records.read('conversations', taskId(id)) ?? fail('unknown_conversation', 404);
    return { ...conversation, messages: this.records.list('messages', id), requests: this.records.list('execution_requests', id),
      plans: this.records.list('plan_versions', id), tasks: this.records.list('task_links', id).map(link => this.task(link.id)),
      activities: this.records.list('continuations', id) };
  }
  appendMessage(conversationId: string, id: string, role: Message['role'], text: string, reference?: string) {
    return this.transaction(() => {
      if (!this.records.read('conversations', taskId(conversationId))) return fail('unknown_conversation', 404);
      taskId(id);
      if (!['user', 'assistant', 'system'].includes(role) || typeof text !== 'string' || !text.trim() || text.length > 100000) return fail('invalid_message', 422);
      const old = this.records.read('messages', id);
      if (old) { if (old.conversationId !== conversationId || old.text !== text || old.role !== role || old.reference !== reference) return fail('id_parameter_conflict'); return old; }
      const value: Message = { id, conversationId, role, text, ...(reference ? { reference } : {}), createdAt: now() };
      this.records.insert('messages', value); return value;
    });
  }
  private userMessage(conversationId: string, messageId: string) {
    const message = this.records.read('messages', taskId(messageId));
    if (!message || message.conversationId !== conversationId || message.role !== 'user') return fail('user_message_required', 422);
    return message;
  }
  request(id: string) { return this.records.read('execution_requests', taskId(id)) ?? fail('unknown_request', 404); }
  private current(id: string, revision: number) {
    const request = this.request(id);
    if (request.revision !== revision || request.state !== 'active' || this.records.read('conversations', request.conversationId)!.currentRequest !== id) return fail('request_not_current');
    return request;
  }
  private retireCurrent(conversationId: string) {
    const conversation = this.records.read('conversations', conversationId)!;
    if (conversation.currentRequest) {
      const request = this.request(conversation.currentRequest);
      if (request.state === 'active') this.saveRequest(transitionRequest(request, { type: 'supersede' }));
    }
    if (conversation.currentPlan) {
      const plan = this.plan(conversation.currentPlan);
      if (['unpresented', 'presented', 'stale'].includes(plan.state)) this.records.save('plan_versions', { ...plan, state: 'superseded' });
    }
  }
  createRequest(conversationId: string, id: string, sourceMessage: string, input: unknown, prepare = true) {
    const goal = goalDraft(input); taskId(id); this.userMessage(conversationId, sourceMessage);
    const old = this.records.read('execution_requests', id);
    if (old) {
      if (old.conversationId !== conversationId || old.sourceMessage !== sourceMessage || !isDeepStrictEqual(old.goal, goal)) return fail('id_parameter_conflict');
      return old;
    }
    return this.transaction(() => {
      this.retireCurrent(conversationId);
      const request = newRequest(id, conversationId, sourceMessage, goal);
      this.records.insert('execution_requests', request);
      this.records.save('conversations', { ...this.records.read('conversations', conversationId)!, currentRequest: id, currentPlan: null });
      return prepare ? this.prepare(id, 1) : request;
    });
  }
  reviseRequest(id: string, revision: number, sourceMessage: string, input: unknown) {
    const goal = goalDraft(input);
    return this.transaction(() => {
      const request = this.request(id);
      if (request.revision !== revision || !canRevise(request) ||
          this.records.read('conversations', request.conversationId)!.currentRequest !== id) return fail('request_not_current');
      this.userMessage(request.conversationId, sourceMessage);
      const next = transitionRequest(request, { type: 'revise', sourceMessage, goal });
      this.retireCurrent(request.conversationId);
      this.saveRequest(next);
      this.records.save('conversations', { ...this.records.read('conversations', request.conversationId)!, currentPlan: null });
      return this.prepare(id, next.revision);
    });
  }
  cancelRequest(id: string, revision: number) {
    return this.transaction(() => {
      const request = this.request(id);
      if (request.revision !== revision) return fail('request_not_current');
      if (request.state === 'cancelled') return request;
      if (request.state === 'executing') return fail('task_already_started_use_stop');
      this.current(id, revision);
      const conversation = this.records.read('conversations', request.conversationId)!;
      if (conversation.currentPlan) this.records.save('plan_versions', { ...this.plan(conversation.currentPlan), state: 'cancelled' });
      this.records.save('conversations', { ...conversation, currentPlan: null });
      const next = transitionRequest(request, { type: 'cancel' }); this.saveRequest(next); return next;
    });
  }
  plan(id: string) { return this.records.read('plan_versions', taskId(id)) ?? fail('unknown_plan', 404); }
  private invalidateFollowups(request: Request) {
    for (const entry of this.records.requestContinuations(request.id)) {
      if (request.state !== 'active' || request.revision !== entry.revision) {
        this.records.save('continuations', { ...entry, state: 'obsolete', token: null });
      }
    }
  }
  private saveRequest(request: Request) {
    this.records.save('execution_requests', request);
    this.invalidateFollowups(request);
  }
  private wait(request: Request, reasons: string[]) {
    const next = transitionRequest(request, { type: 'wait', reasons }); this.saveRequest(next); return next;
  }
  prepare(id: string, revision: number): Request {
    return this.transaction(() => {
      const request = this.current(id, revision);
      if (request.intent === 'inspect_inventory') return this.wait(request, request.scanTask ? ['scan_pending'] : ['inventory_required']);
      if (request.goal.kind === 'inventory' && request.scanTask && request.scanRevision === revision && !request.observedId &&
          this.tasks.get(request.scanTask).state !== 'ended') return this.wait(request, ['scan_pending']);
      const missing = missingGoal(request.goal); if (missing.length) return this.wait(request, missing);
      const goal = request.goal as Goal;
      if (request.previousTasks.some(t => blocksExecution(this.tasks.get(t)))) return this.wait(request, ['stop_or_environment_unconfirmed']);
      let prior: Amount = { value: 0, certainty: 'exact' };
      if (request.adjustment === 'total') {
        if (request.previousTasks.some(id => {
          const link = this.records.read('task_links', id); const old = link?.planId ? this.plan(link.planId).goal : null;
          return !old || old.kind !== goal.kind || old.itemId !== goal.itemId;
        })) return this.wait(request, ['incomparable_total_goal']);
        prior = sumAmounts(request.previousTasks.map(t => amount(this.tasks.get(t), goal)));
        if (prior.certainty !== 'exact' && !(goal.kind === 'inventory' && request.observedId === request.scanTask && request.observedId !== null))
          return this.wait(request, ['previous_result_uncertain']);
      }
      let inventory: number | null = null;
      if (goal.kind === 'inventory') {
        const old = request.observedId;
        if (!old || !this.basis.observationValid(old, goal.itemId!, request.adjustment === 'total' ? request.previousTasks : [])) return this.wait(request, ['inventory_required']);
        inventory = this.records.read('observations', old)!.items[goal.itemId!];
        // A fresh scan already includes the previous executions' gains.
        if (request.scanTask === old) prior = { value: 0, certainty: 'exact' };
      }
      const quantity = Math.max(goal.quantity - (inventory ?? 0) - prior.value!, 0);
      if (quantity === 0) {
        this.appendMessage(request.conversationId, `satisfied-${request.id}-${revision}`, 'system', '依据已确认成果，目标已满足，无需新增刷图。', request.id);
        const next = transitionRequest(request, { type: 'complete' }); this.saveRequest(next); return next;
      }
      let selection: ReturnType<Catalog['select']>;
      try { selection = this.catalog.select(goal.stage, goal.itemId); }
      catch (error) { if (error instanceof TaskError) return this.wait(request, [error.message]); throw error; }
      const conversation = this.records.read('conversations', request.conversationId)!;
      const existing = conversation.currentPlan ? this.plan(conversation.currentPlan) : null;
      if (existing?.requestId === id && existing.revision === revision && existing.quantity === quantity &&
          existing.observationId === (goal.kind === 'inventory' ? request.observedId : null) &&
          ['unpresented', 'presented'].includes(existing.state) && this.basis.planValid(existing)) return this.wait(request, []);
      if (existing && existing.state !== 'started') this.records.save('plan_versions', { ...existing, state: 'superseded' });
      const plan: Plan = { id: randomUUID(), conversationId: request.conversationId, requestId: id, revision, goal,
        quantity, stage: selection.code, catalogVersion: this.catalog.snapshot.version, catalogBasis: this.catalog.basis(selection.code, goal.itemId),
        selection: selection.selection, explanation: selection.explanation, estimate: this.catalog.estimate(selection.code, quantity, goal.itemId),
        resources: { medicine: 0, premium: 0, expiringMedicine: 0 },
        endConditions: ['达到目标', '现有理智不足', '用户停止', '执行或反馈异常'],
        limitations: ['没有预读当前理智，可能部分完成。', '材料停止按执行批次反馈，可能超过目标，不保证零额外批次。',
          ...(selection.entry?.availability === 'scheduled' ? ['该关卡按开放条件提供，资料未确认当前是否开放。'] : [])],
        observationId: goal.kind === 'inventory' ? request.observedId : null, initialInventory: inventory, prior,
        previousTasks: request.adjustment === 'total' && !(goal.kind === 'inventory' && request.scanTask === request.observedId)
          ? request.previousTasks : [], state: 'unpresented', taskId: null, createdAt: now() };
      this.records.insert('plan_versions', plan); this.records.save('conversations', { ...conversation, currentPlan: plan.id });
      this.appendMessage(request.conversationId, `plan-${plan.id}`, 'system', '方案已准备，展示后等待用户确认；仅用现有理智，可能部分完成。', plan.id);
      return this.wait(request, []);
    });
  }
  present(planId: string, id: string) {
    taskId(id);
    return this.transaction(() => {
      const plan = this.plan(planId); this.current(plan.requestId, plan.revision);
      if (!['unpresented', 'presented'].includes(plan.state) || !this.basis.planValid(plan)) return fail('plan_not_current');
      const old = this.records.read('plan_presentations', id);
      if (old) { if (old.planId !== planId) return fail('id_parameter_conflict'); return old; }
      const receipt = { id, conversationId: plan.conversationId, planId, createdAt: now(),
        lastMessageId: this.records.latestMessageId(plan.conversationId) };
      this.records.insert('plan_presentations', receipt); this.records.save('plan_versions', { ...plan, state: 'presented' }); return receipt;
    });
  }
  async confirm(planId: string, presentationId: string, id: string, source: 'button' | 'message', sourceMessage?: string, association?: OperationAssociation) {
    taskId(id);
    this.reconcile({ taskIds: [] });
    let reservation: ReturnType<TaskService['reserve']> | undefined;
    const linked = this.transaction(() => {
      const plan = this.plan(planId);
      if (!['button', 'message'].includes(source)) return fail('invalid_confirmation', 422);
      if (source === 'button' && sourceMessage !== undefined) return fail('invalid_confirmation', 422);
      const receipt = this.records.read('plan_presentations', taskId(presentationId));
      if (!receipt || receipt.planId !== planId) return fail('presentation_required');
      if (source === 'message') {
        this.userMessage(plan.conversationId, sourceMessage ?? '');
        if (this.records.messageConfirmedElsewhere(sourceMessage!, planId)) return fail('confirmation_message_already_used');
      }
      const old = this.records.read('confirmations', id);
      if (old && (old.planId !== planId || old.presentationId !== presentationId || old.source !== source || old.sourceMessage !== (sourceMessage ?? null))) return fail('id_parameter_conflict');
      if (plan.taskId) { associate(association, plan.taskId); return plan.taskId; }
      // Order by persisted messages, not wall-clock timestamps (messages may share a millisecond).
      // Older receipts without a boundary require a fresh presentation before message confirmation.
      if (source === 'message' && (receipt.lastMessageId === undefined ||
          !this.records.messageFollows(sourceMessage!, receipt.lastMessageId))) return fail('confirmation_message_before_presentation');
      this.current(plan.requestId, plan.revision);
      if (plan.state !== 'presented' || this.conversation(plan.conversationId).currentPlan !== planId || !this.basis.planValid(plan)) return fail('plan_not_current');
      const task = randomUUID();
      reservation = this.tasks.reserve({ id: task, params: executionParams(plan.goal, plan.stage, plan.quantity) });
      this.records.insert('confirmations', { id, conversationId: plan.conversationId, planId, presentationId, source,
        sourceMessage: sourceMessage ?? null, taskId: task });
      this.records.insert('task_links', { id: task, conversationId: plan.conversationId, requestId: plan.requestId,
        requestRevision: plan.revision, planId, purpose: 'fight', result: null, resultDigest: null });
      this.records.save('plan_versions', { ...plan, state: 'started', taskId: task });
      this.saveRequest(transitionRequest(this.request(plan.requestId), { type: 'execute' }));
      associate(association, task);
      return task;
    });
    if (reservation) await reservation.dispatch();
    this.reconcile({ taskIds: [linked] }); return this.task(linked);
  }
  async scan(requestId: string, revision: number, task: string, explanation: string, association?: OperationAssociation) {
    taskId(task); if (typeof explanation !== 'string' || !explanation.trim()) return fail('scan_explanation_required', 422);
    const existing = this.records.read('task_links', task);
    if (existing) {
      if (existing.requestId !== requestId || existing.requestRevision !== revision || existing.purpose !== 'inventory') return fail('id_parameter_conflict');
      this.transaction(() => associate(association, task));
      return this.task(task);
    }
    const reservation = this.transaction(() => {
      const request = this.current(requestId, revision);
      if (request.goal.kind !== 'inventory') return fail('inventory_intent_required');
      this.appendMessage(request.conversationId, `scan-${task}`, 'system', explanation, task);
      const reserved = this.tasks.reserve({ id: task, params: { version: 2, kind: 'scan_inventory' } });
      this.records.insert('task_links', { id: task, conversationId: request.conversationId, requestId, requestRevision: revision,
        planId: null, purpose: 'inventory', result: null, resultDigest: null });
      this.saveRequest(transitionRequest(request, { type: 'scan_started', taskId: task }));
      associate(association, task);
      return reserved;
    });
    await reservation.dispatch(); this.reconcile({ taskIds: [task] }); return this.task(task);
  }
  task(id: string) {
    const task = this.tasks.get(id); const link = this.records.read('task_links', id);
    return { ...link, id, origin: link ? 'mvp' : 'engineering_or_legacy', task,
      result: link?.purpose === 'fight' ? this.basis.calculate(link, task) : null };
  }
  inspectInventory(conversationId: string, id: string, sourceMessage: string) {
    const existing = this.records.read('execution_requests', id);
    if (existing) {
      if (existing.conversationId !== conversationId || existing.sourceMessage !== sourceMessage || existing.intent !== 'inspect_inventory') return fail('id_parameter_conflict');
      return existing;
    }
    return this.transaction(() => {
      const request = this.createRequest(conversationId, id, sourceMessage, { kind: 'inventory' }, false);
      const next = transitionRequest(request, { type: 'inspect' });
      this.saveRequest(next); return next;
    });
  }
  reusePlan(planId: string, conversationId: string, requestId: string, sourceMessage: string) {
    const plan = this.plan(planId);
    return this.createRequest(conversationId, requestId, sourceMessage, { ...plan.goal, stage: plan.stage });
  }
  async stop(id: string) { const result = await this.tasks.stop(id); this.reconcile({ taskIds: [id] }); return result; }
  async adjust(taskId: string, requestId: string, sourceMessage: string, goal: unknown, semantics: 'total' | 'additional', association?: OperationAssociation) {
    const link = this.records.read('task_links', taskId) ?? fail('business_task_required');
    if (link.purpose !== 'fight' || !link.planId) return fail('fight_task_required');
    const plan = this.plan(link.planId);
    this.userMessage(link.conversationId, sourceMessage);
    if (!['total', 'additional'].includes(semantics)) return fail('invalid_adjustment', 422);
    // Commit the intent and stop even if the replacement goal is incomplete.
    const draft = goalDraft(goal);
    if (semantics === 'total' && ((draft.kind && draft.kind !== plan.goal.kind) || (draft.itemId && draft.itemId !== plan.goal.itemId))) return fail('incomparable_total_goal', 422);
    const old = this.records.read('execution_requests', requestId);
    if (old) {
      if (old.sourceMessage !== sourceMessage || old.adjustment !== semantics || !old.previousTasks.includes(taskId) || !isDeepStrictEqual(old.goal, draft)) return fail('id_parameter_conflict');
      this.transaction(() => associate(association, requestId));
      return old;
    }
    const stop = this.transaction(() => {
      this.createRequest(link.conversationId, requestId, sourceMessage, draft, false);
      const request = this.request(requestId);
      this.saveRequest(transitionRequest(request, { type: 'adjust', previousTasks: [...plan.previousTasks, taskId],
        semantics, observedId: semantics === 'total' ? plan.observationId : null }));
      const conversation = this.records.read('conversations', link.conversationId)!;
      if (conversation.currentPlan) this.records.save('plan_versions', { ...this.plan(conversation.currentPlan), state: 'superseded' });
      this.records.save('conversations', { ...conversation, currentPlan: null });
      const reserved = this.tasks.reserveStop(taskId);
      associate(association, requestId);
      return reserved;
    });
    await stop.dispatch(); this.reconcile({ taskIds: [taskId] }); return this.request(requestId);
  }
  recordInventoryChange(id: string, itemIds: string[] | null, reason: string, conversationId = '', task: string | null = null) {
    const result = this.transaction(() => this.basis.recordChange(id, itemIds, reason, conversationId, task));
    this.reconcile({ taskIds: [], inventoryChanged: true }); return result;
  }
  reconcile(scope?: { taskIds: string[]; inventoryChanged?: boolean; catalogChanged?: boolean }) {
    if (scope) {
      scope.taskIds.forEach(id => this.pendingTasks.add(id));
      this.inventoryProjectionPending ||= !!scope.inventoryChanged;
      this.catalogProjectionPending ||= !!scope.catalogChanged;
    } else this.fullProjectionPending = true;
    if (this.reconciling || this.closing || this.tasks.storageFailed) return;
    this.reconciling = true;
    try {
      this.transaction(() => {
        const full = this.fullProjectionPending;
        const ids = full ? this.tasks.store.all().map(t => t.id) : [...this.pendingTasks];
        let inventoryChanged = this.inventoryProjectionPending;
        // Phase 1: persist all affected facts before advancing any request.
        for (const id of ids) inventoryChanged = this.projection.capture(this.tasks.get(id)) || inventoryChanged;
        const links = full ? this.records.list('task_links') : this.records.affectedLinks(ids, inventoryChanged);
        // Observations must be stored before results that depend on those scans.
        const ordered = [...links.filter(link => link.purpose === 'inventory'), ...links.filter(link => link.purpose === 'fight')];
        const effects = ordered.map(link => this.projection.apply(link)).filter((e): e is ProjectionEffect => e !== null);
        // Phase 2: business rules own request transitions, plans and messages.
        for (const effect of effects) this.advance(effect);
        const requests = this.records.currentRequests(full || this.catalogProjectionPending ? undefined : ids, inventoryChanged);
        for (const request of requests) {
          const conversation = this.records.read('conversations', request.conversationId)!;
          if (conversation.currentPlan) {
            const plan = this.plan(conversation.currentPlan);
            if (['unpresented', 'presented'].includes(plan.state) && !this.basis.planValid(plan)) {
              this.records.save('plan_versions', { ...plan, state: 'stale' });
            }
          }
          if (request.state === 'active' && request.previousTasks.length) {
            const updated = this.prepare(request.id, request.revision);
            if (updated.waiting.length && !updated.waiting.includes('stop_or_environment_unconfirmed')) {
              this.enqueue(updated, 'adjustment_needs_input', request.previousTasks.at(-1)!);
            }
          }
          this.invalidateFollowups(this.request(request.id));
        }
        if (full) for (const entry of this.records.list('continuations')) this.invalidateFollowups(this.request(entry.requestId));
      });
      this.pendingTasks.clear(); this.fullProjectionPending = false;
      this.inventoryProjectionPending = false; this.catalogProjectionPending = false; this.projectionFailure = null;
    } catch {
      // Execution evidence is already committed by TaskService. Keep the failed
      // scope for a later deterministic projection; never label it an execution DB failure.
      this.projectionFailure = 'business_projection_failed';
    } finally { this.reconciling = false; }
    // Phase 3: only committed business state may reach a consumer.
    this.dispatchFollowups();
  }
  private advance(effect: ProjectionEffect) {
    const { link } = effect; const request = this.request(link.requestId);
    if (effect.type === 'scan') {
      if (!awaitsScan(request, link.id) || this.records.read('conversations', request.conversationId)!.currentRequest !== request.id) return;
      const { reliable } = effect.observation;
      this.saveRequest(transitionRequest(request, { type: 'scan_observed', taskId: link.id }));
      if (request.intent === 'inspect_inventory') {
        this.appendMessage(link.conversationId, `scan-result-${link.id}`, 'system', reliable ? '库存扫描完成；识别数量见任务结果，缺失材料仍未知。' : '库存扫描已结束，识别结果存在未知部分。', link.id);
        return;
      }
      const updated = this.prepare(request.id, request.revision);
      this.appendMessage(link.conversationId, `scan-result-${link.id}`, 'system', reliable ? '库存扫描完成，按已识别材料准备方案。' : '库存识别不完整或不可靠，未知部分不能按零处理。', link.id);
      if (updated.waiting.length) this.enqueue(updated, 'scan_needs_input', link.id);
    } else if (effect.terminal) {
      this.appendMessage(link.conversationId, `result-${digest({ task: link.id, resultDigest: effect.resultDigest }).slice(0,40)}`,
        'system', resultText(effect.plan.goal, effect.result), link.id);
      if (request.state === 'executing') this.saveRequest(transitionRequest(request, { type: 'complete' }));
    }
  }
  private enqueue(request: Request, reason: string, taskId: string | null) {
    if (this.retiring) return;
    const id = digest({ request: request.id, revision: request.revision, reason, taskId });
    if (!this.records.read('continuations', id)) this.records.insert('continuations', { id, conversationId: request.conversationId,
      requestId: request.id, revision: request.revision, taskId, state: 'pending', reason, token: null });
  }
  setFollowupConsumer(consumer: (context: FollowUp) => Promise<void>) {
    this.followups.setConsumer(consumer); this.dispatchFollowups();
  }
  private dispatchFollowups() {
    if (this.closing || this.retiring || this.projectionFailure || this.tasks.storageFailed) return;
    try { this.followups.dispatch(); } catch { this.projectionFailure = 'followup_storage_failed'; }
  }
  acceptFollowup<T>(id: string, token: string, apply: (request: Request) => T): T {
    if (this.retiring) return fail('business_unavailable', 503);
    return this.transaction(() => {
      const entry = this.records.read('continuations', id);
      if (!entry || entry.state !== 'processing' || entry.token !== token) return fail('followup_not_current');
      const result = apply(this.current(entry.requestId, entry.revision));
      this.records.save('continuations', { ...entry, state: 'completed', token: null });
      return result;
    });
  }
  global() {
    return { projection: { available: !this.projectionFailure, reason: this.projectionFailure },
      admission: this.projectionFailure ? { ...this.tasks.admission(), state: 'unavailable' as const } : this.tasks.admission(), tasks: this.tasks.list().filter(t => blocksExecution(t)).map(t => this.task(t.id)),
      conversations: this.records.list('conversations'), catalogVersion: this.catalog.snapshot.version };
  }
  beginShutdown() {
    // Freeze external mutations and consumers now; keep deterministic projection until final close.
    this.retiring = true;
    return this.followupsClosing ??= this.followups.close();
  }
  async close() { this.closing = true; await this.beginShutdown(); this.tasks.onSynchronized = undefined; }
}

import { Store } from './store.ts';
import { submission, taskId, TaskError } from './task-contract.ts';
import type { Update, SyncStatus, TaskView } from './task-contract.ts';

export interface AdapterClient {
  instance: string;
  call(path: string, method?: string, body?: unknown): Promise<unknown>;
}

export class TaskService {
  readonly store: Store;
  readonly adapter: AdapterClient;
  readonly source: string;
  closing = false;
  exited = false;
  storageFailed = false;
  private synchronizations = new Map<string, SyncStatus>();
  private stopIntents = new Set<string>();

  constructor(store: Store, adapter: AdapterClient, source: string) {
    this.store = store; this.adapter = adapter; this.source = source;
  }
  get(id: string): TaskView {
    taskId(id);
    const result = this.store.view(id, this.synchronizations.get(id));
    if (!result) throw new TaskError(404, 'unknown_task');
    if (this.storageFailed) {
      result.sync = { ...result.sync, available: false, reason: 'storage_unavailable' };
      result.certainty = 'lower_bound'; result.device = 'needs_check';
      if (!['ended', 'rejected'].includes(result.state)) result.state = 'unknown';
    }
    return result;
  }
  list() { return this.store.all().map(t => this.get(t.id)); }
  private unavailable(id: string, reason: string) {
    const prior = this.synchronizations.get(id) ?? this.store.view(id)?.sync;
    this.synchronizations.set(id, { available: false, last_success_at: prior?.last_success_at ?? null, reason });
  }
  async sync(id: string) {
    const row = this.store.get(id);
    if (!row || JSON.parse(row.snapshot).state === 'rejected') return;
    try {
      const update = await this.adapter.call(`/executions/${id}?after=${row.cursor}`) as Update;
      if (update.instance !== this.adapter.instance) throw new Error('wrong_adapter_instance');
      if (this.exited && update.snapshot.state !== 'ended') {
        update.snapshot = { ...update.snapshot, state: 'unknown', certainty: 'lower_bound', device: 'needs_check', reason: 'executor_exited' };
      }
      try { this.store.apply(id, update); }
      catch (error) { this.storageFailed = true; throw error; }
      this.synchronizations.set(id, { available: !this.exited, last_success_at: Date.now() / 1000,
        reason: this.exited ? 'executor_exited' : null });
      // A stop may precede the Adapter's acceptance (lost/slow submit response).
      if ((this.stopIntents.has(id) || this.get(id).stop_requested || this.get(id).evidence_conflict) &&
          !update.snapshot.automation_stopped && ['accepted', 'running'].includes(update.snapshot.state)) {
        await this.adapter.call(`/executions/${id}/stop`, 'POST').catch(() => {});
      }
    } catch (error) {
      this.unavailable(id, this.storageFailed ? 'storage_unavailable' : 'adapter_unavailable');
      throw error;
    }
  }
  async poll() {
    for (const row of this.store.all()) {
      try { await this.sync(row.id); } catch { /* get exposes the last known result and sync failure. */ }
    }
  }
  async submit(input: unknown) {
    const { id, params } = submission(input);
    const existing = this.store.get(id);
    if (existing) {
      if (existing.params !== JSON.stringify(params)) throw new TaskError(409, 'id_parameter_conflict');
      return this.get(id); // Never resend an uncertain operation, including after restart.
    }
    if (this.closing || this.exited || this.storageFailed) throw new TaskError(503, 'service_unavailable');
    if (this.list().some(t => t.state !== 'rejected' && (!['ended'].includes(t.state) ||
        !t.automation_stopped || t.device !== 'ready'))) throw new TaskError(409, 'device_busy_or_uncertain');
    // Reserve synchronously before the first await, so concurrent callers cannot both pass admission.
    try { this.store.prepare(id, params, this.source); }
    catch { this.storageFailed = true; throw new TaskError(503, 'storage_unavailable'); }
    try {
      await this.adapter.call('/executions', 'POST', { id, params });
      await this.sync(id);
    } catch (error) {
      if (error instanceof TaskError && [409, 422].includes(error.status)) {
        this.store.mark(id, { state: 'rejected', device: 'ready', reason: error.message });
        throw error;
      }
      this.unavailable(id, 'submission_not_confirmed');
    }
    return this.get(id);
  }
  async stop(id: string) {
    taskId(id);
    const known = this.get(id);
    // A repeated stop must not erase terminal evidence, even after the Adapter exits.
    if (['ended', 'rejected'].includes(known.state)) {
      return { id, stop_requested: false, confirmed: known.automation_stopped };
    }
    this.stopIntents.add(id);
    try { this.store.mark(id, known.state === 'unknown' ? { stop_requested: true } :
      { state: 'stopping', reason: 'stop_requested', stop_requested: true }); }
    catch { this.storageFailed = true; }
    let delivered = false;
    try { await this.adapter.call(`/executions/${id}/stop`, 'POST'); delivered = true; }
    catch { this.unavailable(id, 'stop_delivery_unconfirmed'); }
    return { id, stop_requested: true, delivered, confirmed: false };
  }
  adapterExited() {
    this.exited = true;
    for (const row of this.store.all()) {
      this.unavailable(row.id, 'executor_exited');
      if (!['ended', 'rejected'].includes(this.get(row.id).state)) {
        try { this.store.mark(row.id, { state: 'unknown', certainty: 'lower_bound', device: 'needs_check', reason: 'executor_exited' }); }
        catch { this.storageFailed = true; }
      }
    }
  }
}

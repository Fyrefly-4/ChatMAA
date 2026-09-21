import type { BusinessService, FollowUp } from '../business/service.ts';
import { TaskError } from '../task-contract.ts';
import { RuntimeRecords } from './records.ts';
import type { Turn } from './records.ts';
import { contextFor } from './context.ts';

export type RunInput = { turn: Turn; context: ReturnType<typeof contextFor>; signal: AbortSignal; assertCurrent: () => void;
  track: <T>(work: Promise<T>) => Promise<T> };
export type RunTurn = (input: RunInput) => Promise<string>;
export type RuntimeOptions = { timeoutMs?: number; maxConcurrent?: number };

// Owns model lifetime, not game lifetime. Deterministic business operations stay available separately.
export class RuntimeService {
  readonly business: BusinessService;
  readonly records: RuntimeRecords;
  private readonly run?: RunTurn;
  private readonly timeoutMs: number;
  private readonly maxConcurrent: number;
  private closing = false;
  private storageFailed = false;
  private running = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private providerCalls = new Set<Promise<string>>();
  private operations = new Set<Promise<unknown>>();
  private followups = new Map<string, { conversationId: string; abort: AbortController }>();

  constructor(business: BusinessService, run?: RunTurn, options: RuntimeOptions = {}) {
    this.business = business; this.run = run;
    this.timeoutMs = options.timeoutMs ?? 60000; this.maxConcurrent = options.maxConcurrent ?? 4;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60000 ||
        !Number.isSafeInteger(this.maxConcurrent) || this.maxConcurrent < 1 || this.maxConcurrent > 16)
      throw new Error('invalid_runtime_options');
    this.records = new RuntimeRecords(business.tasks.store); this.records.recover();
  }
  status() {
    return { available: !!this.run && !this.closing && !this.storageFailed, closing: this.closing,
      storageFailed: this.storageFailed, active: this.running.size, inFlightModelCalls: this.providerCalls.size };
  }
  enableFollowups() { this.business.setFollowupConsumer(context => this.consumeFollowup(context)); }
  private async consumeFollowup(followup: FollowUp) {
    if (!this.run || this.closing || this.storageFailed) throw new TaskError(503, 'runtime_unavailable');
    const abort = new AbortController();
    this.followups.set(followup.record.id, { conversationId: followup.record.conversationId, abort });
    const signal = AbortSignal.any([abort.signal, followup.signal]);
    let listener: (() => void) | undefined;
    try {
      const active = [...this.running.entries()].filter(([id]) => this.records.read(id)?.conversationId === followup.record.conversationId);
      const interrupted = new Promise<never>((_resolve, reject) => {
        listener = () => reject(new Error('followup_interrupted'));
        signal.addEventListener('abort', listener, { once: true }); if (signal.aborted) listener();
      });
      await Promise.race([Promise.allSettled(active.map(([, entry]) => entry.done)), interrupted]);
      signal.throwIfAborted();
      const current = this.business.request(followup.record.requestId);
      const entry = this.business.records.read('continuations', followup.record.id);
      if (current.state !== 'active' || current.revision !== followup.record.revision || entry?.token !== followup.record.token || entry.state !== 'processing')
        throw new TaskError(409, 'followup_not_current');
      const turn = this.records.beginFollowup(current.conversationId, current.sourceMessage, followup.record.id);
      const done = this.execute(turn, abort, { ...followup, signal }).finally(() => this.running.delete(turn.id));
      this.running.set(turn.id, { abort, done });
      await done;
      if (this.records.read(turn.id)?.state !== 'completed') throw new Error('followup_not_published');
    } finally {
      if (listener) signal.removeEventListener('abort', listener);
      this.followups.delete(followup.record.id);
    }
  }
  submit(conversationId: string, messageId: string, text: string) {
    if (this.closing || this.storageFailed) throw new TaskError(503, 'runtime_unavailable');
    let accepted;
    try { accepted = this.records.accept(this.business, conversationId, messageId, text); }
    catch (error) { if (!(error instanceof TaskError)) this.storageFailed = true; throw error; }
    if (accepted.duplicate) return accepted.turn;
    for (const [id, entry] of this.followups) if (entry.conversationId === conversationId) {
      entry.abort.abort(); this.business.interruptFollowup(id);
    }
    for (const id of accepted.interrupted) this.running.get(id)?.abort.abort();
    if (!this.run || this.providerCalls.size >= this.maxConcurrent) {
      return this.records.finish(accepted.turn.id, 'failed', this.run ? 'model_busy' : 'model_unavailable');
    }
    const abort = new AbortController();
    // Schedule after admission commits. No provider or asynchronous work runs inside SQLite transactions.
    const done = Promise.resolve().then(() => this.execute(accepted.turn, abort))
      .finally(() => this.running.delete(accepted.turn.id));
    this.running.set(accepted.turn.id, { abort, done });
    return accepted.turn;
  }
  private assertCurrent(turn: Turn, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.closing || this.storageFailed) throw new TaskError(503, 'runtime_unavailable');
    this.records.assertCurrent(turn);
  }
  private async execute(turn: Turn, abort: AbortController, followup?: FollowUp) {
    const timeout = setTimeout(() => abort.abort(new Error('model_timeout')), this.timeoutMs);
    const signal = followup ? AbortSignal.any([abort.signal, followup.signal]) : abort.signal;
    let listener: (() => void) | undefined;
    try {
      this.assertCurrent(turn, signal);
      if (this.providerCalls.size >= this.maxConcurrent) throw new TaskError(503, 'model_busy');
      const context = contextFor(this.business, turn.conversationId, turn.sourceMessage, 48000, turn.sourceMessages);
      if (followup) Object.assign(context, { followup: { id: followup.record.id, requestId: followup.record.requestId,
        revision: followup.record.revision, reason: followup.record.reason, taskId: followup.record.taskId } });
      const work = Promise.resolve().then(() => {
        this.assertCurrent(turn, signal);
        return this.run!({ turn, context, signal, assertCurrent: () => this.assertCurrent(turn, signal), track: work => {
          this.operations.add(work);
          void work.then(() => this.operations.delete(work), () => this.operations.delete(work));
          return work;
        } });
      });
      this.providerCalls.add(work);
      // Both handlers consume late settlement; neither writes records after the turn is retired.
      void work.then(() => this.providerCalls.delete(work), () => this.providerCalls.delete(work));
      const interrupted = new Promise<never>((_resolve, reject) => {
        listener = () => reject(signal.reason);
        signal.addEventListener('abort', listener, { once: true });
        if (signal.aborted) listener();
      });
      const text = await Promise.race([work, interrupted]);
      this.assertCurrent(turn, signal);
      if (followup) this.business.acceptFollowup(followup.record.id, followup.record.token!, () => {
        this.assertCurrent(turn, signal); return this.records.publish(this.business, turn, text);
      });
      else this.records.publish(this.business, turn, text);
    } catch (error) {
      if (!this.closing && !this.storageFailed) {
        try {
          if (this.records.current(turn)) this.records.finish(turn.id, signal.aborted ? 'interrupted' : 'failed',
            signal.aborted ? (signal.reason?.message === 'model_timeout' ? 'model_timeout' : 'cancelled') :
              error instanceof TaskError ? error.message : 'model_or_runtime_failed');
        } catch { this.storageFailed = true; }
      }
    } finally {
      clearTimeout(timeout);
      if (listener) signal.removeEventListener('abort', listener);
    }
  }
  read(id: string, after = 0) {
    const turn = this.records.read(id);
    if (!turn) throw new TaskError(404, 'unknown_turn');
    return { turn, activities: this.records.activities(id, after) };
  }
  conversation(id: string) {
    const business = this.business.conversation(id);
    const turns = this.business.tasks.store.db.prepare('SELECT body FROM runtime_turns WHERE conversation_id=? ORDER BY generation DESC LIMIT 20')
      .all(id).map(row => JSON.parse(String(row.body)) as Turn);
    return { business, turns, presentation: business.currentPlan ? this.business.records.latestPresentation(business.currentPlan) : null };
  }
  async settled(id: string) { await this.running.get(id)?.done; return this.read(id); }
  async close() {
    if (!this.closing) {
      this.closing = true;
      for (const entry of this.followups.values()) entry.abort.abort();
      for (const [id, entry] of this.running) {
        entry.abort.abort();
        try { this.records.finish(id, 'interrupted', 'host_closing'); } catch { this.storageFailed = true; }
      }
    }
    await Promise.allSettled([...this.running.values()].map(entry => entry.done));
    await Promise.allSettled([...this.operations]);
  }
}

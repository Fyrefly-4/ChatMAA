import type { BusinessService } from '../business/service.ts';
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
  submit(conversationId: string, messageId: string, text: string) {
    if (this.closing || this.storageFailed) throw new TaskError(503, 'runtime_unavailable');
    let accepted;
    try { accepted = this.records.accept(this.business, conversationId, messageId, text); }
    catch (error) { if (!(error instanceof TaskError)) this.storageFailed = true; throw error; }
    if (accepted.duplicate) return accepted.turn;
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
  private async execute(turn: Turn, abort: AbortController) {
    const timeout = setTimeout(() => abort.abort(new Error('model_timeout')), this.timeoutMs);
    const signal = abort.signal;
    let listener: (() => void) | undefined;
    try {
      this.assertCurrent(turn, signal);
      if (this.providerCalls.size >= this.maxConcurrent) throw new TaskError(503, 'model_busy');
      const context = contextFor(this.business, turn.conversationId, turn.sourceMessage, 48000, turn.sourceMessages);
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
      this.records.publish(this.business, turn, text);
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
  async settled(id: string) { await this.running.get(id)?.done; return this.read(id); }
  async close() {
    if (!this.closing) {
      this.closing = true;
      for (const [id, entry] of this.running) {
        entry.abort.abort();
        try { this.records.finish(id, 'interrupted', 'host_closing'); } catch { this.storageFailed = true; }
      }
    }
    await Promise.allSettled([...this.running.values()].map(entry => entry.done));
    await Promise.allSettled([...this.operations]);
  }
}

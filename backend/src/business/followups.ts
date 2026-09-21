import { randomUUID } from 'node:crypto';
import type { BusinessRecords, Continuation } from './records.ts';

// Owns consumer lifetime only. BusinessService supplies and validates context;
// accepting a returned operation remains the service's version-checked transaction.
export class FollowupRunner<T> {
  private consumer?: (context: T) => Promise<void>;
  private active = new Set<Promise<void>>();
  private abort = new AbortController();
  private closing = false;
  private controllers = new Map<string, AbortController>();
  readonly records: BusinessRecords;
  readonly context: (record: Continuation, signal: AbortSignal) => T;
  readonly failed: (error: unknown) => void;
  constructor(records: BusinessRecords, context: (record: Continuation, signal: AbortSignal) => T, failed: (error: unknown) => void) {
    this.records = records; this.context = context; this.failed = failed;
    for (const entry of records.list('continuations')) if (entry.state === 'processing') {
      records.save('continuations', { ...entry, state: 'interrupted', token: null });
    }
  }
  setConsumer(consumer: (context: T) => Promise<void>) { this.consumer = consumer; }
  interrupt(id: string) {
    const current = this.records.read('continuations', id);
    if (current && ['pending', 'processing'].includes(current.state)) {
      this.records.save('continuations', { ...current, state: 'interrupted', token: null });
    }
    // Runtime admission may already have invalidated the durable record atomically.
    if (current && ['pending', 'processing', 'interrupted'].includes(current.state)) this.controllers.get(id)?.abort();
  }
  dispatch() {
    if (!this.consumer || this.closing) return;
    for (const entry of this.records.pendingContinuations()) {
      const record = { ...entry, state: 'processing' as const, token: randomUUID() };
      this.records.save('continuations', record);
      const controller = new AbortController(); this.controllers.set(entry.id, controller);
      const signal = AbortSignal.any([this.abort.signal, controller.signal, AbortSignal.timeout(60000)]);
      let abortListener: () => void;
      const interrupted = new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(new Error('followup_interrupted'));
        signal.addEventListener('abort', abortListener, { once: true });
        if (signal.aborted) abortListener();
      });
      const finish = (state: 'completed' | 'failed' | 'interrupted') => {
        const current = this.records.read('continuations', entry.id)!;
        if (current.state === 'processing') this.records.save('continuations', { ...current, state, token: null });
      };
      const consumer = this.consumer;
      const work = Promise.race([interrupted, Promise.resolve().then(() => {
        signal.throwIfAborted(); return consumer(this.context(record, signal));
      })]).then(() => finish('completed'), () => finish(this.closing ? 'interrupted' : 'failed'))
        .catch(error => this.failed(error))
        .finally(() => { signal.removeEventListener('abort', abortListener); this.active.delete(work); this.controllers.delete(entry.id); });
      this.active.add(work);
    }
  }
  async close() { this.closing = true; this.abort.abort(); await Promise.allSettled([...this.active]); }
}

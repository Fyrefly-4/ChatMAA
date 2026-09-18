import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { repository } from '../src/config.ts';
import { startHost } from '../src/host.ts';
import { createApp } from '../src/app.ts';
import type { Update } from '../src/task-contract.ts';

const run = resolve(repository, '.artifacts/checks', `execution-${Date.now()}`);
mkdirSync(run, { recursive: true });
const params = (count = 10) => ({ stage: '1-7', count, medicine: 0, premium: 0 });
async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise(r => setTimeout(r, 30));
  }
  throw new Error('expected observable result did not arrive');
}
async function setup(name: string) {
  const dataDir = resolve(run, name);
  const host = await startHost({ python: resolve(repository, 'adapter/maa/.venv/Scripts/python.exe'),
    port: 0, dataDir, mode: 'maa-replay', pollMs: 60, httpTimeoutMs: 500, leaseMs: 5000, stopDeadlineMs: 1500 });
  const app = createApp(host.tasks, 'test-client', () => {});
  const headers = { 'x-app-token': 'test-client' };
  const request = (method: 'GET' | 'POST', url: string, payload?: object) => app.inject({ method, url, headers, payload });
  const audit = () => readFileSync(resolve(dataDir, 'worker-audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const close = async () => { await app.close(); return host.close(); };
  return { host, app, request, audit, close, dataDir };
}

test('formal HTTP and in-process contract, ten cycles, idempotency, records and next operation', async t => {
  const x = await setup('normal'); t.after(x.close);
  assert.equal((await x.request('GET', '/tasks')).json().length, 0);
  for (const p of [params(0), params(1.5), { ...params(), count: true }, { ...params(), count: '10' },
    params(2147483648), { ...params(), stage: '2-1' }, { ...params(), medicine: 1 }, { ...params(), premium: 1 }]) {
    const input = { id: randomUUID(), params: p };
    assert.equal((await x.request('POST', '/tasks', input)).statusCode, 422);
    await assert.rejects(x.host.tasks.submit(input));
  }
  assert.equal((await x.request('GET', '/tasks')).json().length, 0);
  assert.equal((await x.request('POST', '/lab/faults', {})).statusCode, 404);
  assert.equal((await x.app.inject({ method: 'GET', url: '/tasks' })).statusCode, 403);
  assert.equal((await x.app.inject({ method: 'GET', url: '/tasks', headers: { 'x-app-token': 'test-client', origin: 'http://localhost' } })).statusCode, 403);
  assert.equal((await x.request('POST', '/tasks', { id: 'ten', params: params() })).statusCode, 202);
  await x.host.tasks.submit({ id: 'ten', params: params() });
  assert.equal((await x.request('POST', '/tasks', { id: 'ten', params: params(2) })).statusCode, 409);
  assert.equal((await x.request('POST', '/tasks', { id: 'conflict', params: params() })).statusCode, 409);
  const result = await until(() => x.host.tasks.get('ten'), v => v.state === 'ended');
  assert.equal(result.confirmed, 10); assert.equal(result.certainty, 'exact');
  assert.equal(result.automation_stopped, true); assert.equal(result.device, 'ready');
  assert.equal(result.sync.available, true); assert.equal(result.evidence_source, 'offline_callback_replay');
  assert.equal(result.gap, false); assert.equal(x.audit().length, 1);
  const db = new DatabaseSync(resolve(x.dataDir, 'executor.sqlite'), { readOnly: true });
  try {
    const final = JSON.parse(String(db.prepare('SELECT snapshot FROM executions WHERE id=?').get('ten')!.snapshot));
    assert.equal(final.seq, result.cursor); assert.equal(final.confirmed, result.confirmed);
    assert.equal(x.host.tasks.store.db.prepare('SELECT count(*) AS n FROM evidence WHERE id=?').get('ten')!.n,
      db.prepare('SELECT count(*) AS n FROM events WHERE id=?').get('ten')!.n);
  } finally { db.close(); }
  await x.host.tasks.stop('ten'); assert.equal(x.host.tasks.get('ten').state, 'ended');
  for (const id of ['CON', 'con']) {
    await x.host.tasks.submit({ id, params: params(1) });
    await until(() => x.host.tasks.get(id), v => v.state === 'ended');
    assert.equal(x.host.tasks.get(id).confirmed, 1);
  }
  assert.equal(x.audit().length, 3);
  const closed = await x.close();
  assert.equal(closed.handoffComplete, true); assert.equal(closed.childExited, true);
  assert(closed.finalTasks.every(t => t.state === 'ended' && t.automation_stopped));
});

test('lost submission response never creates another execution; communication failure is visible', async t => {
  const x = await setup('lost-response'); t.after(x.close);
  const original = x.host.tasks.adapter.call;
  let submissions = 0;
  x.host.tasks.adapter.call = async (path, method, body) => {
    const value = await original(path, method, body);
    if (path === '/executions') { submissions++; throw new Error('response lost after acceptance'); }
    return value;
  };
  await x.host.tasks.submit({ id: 'op', params: params(1) });
  await x.host.tasks.submit({ id: 'op', params: params(1) });
  const ended = await until(() => x.host.tasks.get('op'), v => v.state === 'ended');
  assert.equal(ended.confirmed, 1); assert.equal(submissions, 1); assert.equal(x.audit().length, 1);
  x.host.tasks.adapter.call = async (path, method, body) => {
    if (path.startsWith('/executions/')) throw new Error('offline transport');
    return original(path, method, body);
  };
  await assert.rejects(x.host.tasks.sync('op'));
  const stale = x.host.tasks.get('op');
  assert.equal(stale.confirmed, 1); assert.equal(stale.sync.available, false);
  assert.equal(typeof stale.sync.last_success_at, 'number');
  x.host.tasks.adapter.call = original;
  // Real Adapter termination, without closing the business store, must preserve ended state.
  // The executor may exit after accepting shutdown, before the response body arrives.
  await original('/shutdown', 'POST').catch(error => {
    assert(error instanceof TypeError && (error as Error & { cause?: { code?: string } }).cause?.code === 'ECONNRESET');
  });
  await until(() => x.host.tasks.exited, Boolean);
  await x.host.tasks.stop('op');
  assert.equal(x.host.tasks.get('op').state, 'ended');
  assert.equal(x.host.tasks.get('op').sync.available, false);
});

test('stop, delayed polling, partial results and unknown environment block a conflicting request', async t => {
  const x = await setup('stop'); t.after(x.close);
  await x.host.tasks.submit({ id: 'op', params: params(100) });
  await until(() => x.host.tasks.get('op'), v => v.confirmed >= 1);
  const original = x.host.tasks.adapter.call;
  let release!: () => void;
  let captured!: () => void;
  const arrived = new Promise<void>(r => { captured = r; });
  const gate = new Promise<void>(r => { release = r; });
  let held = false;
  x.host.tasks.adapter.call = async (path, method, body) => {
    const value = await original(path, method, body);
    if (!held && path.startsWith('/executions/op?')) { held = true; captured(); await gate; }
    return value;
  };
  const delayed = x.host.tasks.sync('op');
  await arrived;
  const stop = await x.host.tasks.stop('op');
  assert.equal(stop.confirmed, false);
  assert.equal((await x.request('POST', '/tasks', { id: 'other', params: params() })).statusCode, 409);
  release(); await delayed;
  assert.notEqual(x.host.tasks.get('op').state, 'running');
  x.host.tasks.adapter.call = original;
  const ended = await until(() => x.host.tasks.get('op'), v => v.state === 'ended');
  assert(ended.confirmed >= 1 && ended.confirmed < 100);
  assert.equal(ended.certainty, 'lower_bound'); assert.equal(ended.device, 'needs_check');
  assert.equal(ended.automation_stopped, true);
  await assert.rejects(x.host.tasks.submit({ id: 'after', params: params() }));
});

test('duplicate or missing transport evidence never becomes extra success or exact coverage', async t => {
  const x = await setup('evidence'); t.after(x.close);
  const original = x.host.tasks.adapter.call;
  x.host.tasks.adapter.call = async (path, method, body) => {
    const value = await original(path, method, body);
    if (path.startsWith('/executions/')) {
      const update = value as Update;
      update.events = update.events.filter(e => e.seq !== 2).flatMap(e => [e, e]);
    }
    return value;
  };
  await x.host.tasks.submit({ id: 'op', params: params(1) });
  const ended = await until(() => x.host.tasks.get('op'), v => v.state === 'ended');
  assert.equal(ended.confirmed, 1); assert.equal(ended.gap, true); assert.equal(ended.certainty, 'lower_bound');
  assert.equal(x.audit().length, 1);
});

test('business SQLite write failure cannot prevent the stop signal', async t => {
  const x = await setup('storage'); t.after(x.close);
  await x.host.tasks.submit({ id: 'op', params: params(100) });
  await until(() => x.host.tasks.get('op'), v => v.confirmed >= 1);
  x.host.tasks.store.db.exec('PRAGMA query_only=ON');
  const stopped = await x.host.tasks.stop('op');
  assert('delivered' in stopped && stopped.delivered);
  const native = await until(async () => await x.host.tasks.adapter.call('/executions/op') as Update,
    v => v.snapshot.state === 'ended');
  assert.equal(native.snapshot.automation_stopped, true);
  assert(native.snapshot.confirmed < 100);
  assert.equal(x.host.tasks.get('op').sync.available, false);
  assert.equal((await x.close()).handoffComplete, false);
});

test('conflicting evidence retains known count and blocks a new execution', async t => {
  const x = await setup('conflicting-evidence'); t.after(x.close);
  await x.host.tasks.submit({ id: 'op', params: params(1) });
  await until(() => x.host.tasks.get('op'), v => v.state === 'ended');
  const original = x.host.tasks.adapter.call;
  x.host.tasks.adapter.call = async (path, method, body) => {
    const value = await original(path.startsWith('/executions/op?') ? '/executions/op?after=0' : path, method, body);
    if (path.startsWith('/executions/op?')) {
      const update = value as Update;
      update.events[0]!.snapshot.confirmed = 99;
      update.snapshot.confirmed = 99;
    }
    return value;
  };
  await x.host.tasks.sync('op');
  assert.equal(x.host.tasks.get('op').confirmed, 1);
  assert.equal(x.host.tasks.get('op').reason, 'evidence_conflict');
  await assert.rejects(x.host.tasks.submit({ id: 'next', params: params(1) }));
});

test('stop preserves unknown cause while still delivering the stop request', async t => {
  const x = await setup('unknown-stop'); t.after(x.close);
  await x.host.tasks.submit({ id: 'op', params: params(1) });
  await until(() => x.host.tasks.get('op'), v => v.state === 'ended');
  x.host.tasks.store.mark('op', { state: 'unknown', reason: 'worker_error' });
  const original = x.host.tasks.adapter.call;
  let delivered = false;
  x.host.tasks.adapter.call = async (path, method, body) => {
    if (path === '/executions/op/stop') delivered = true;
    return original(path, method, body);
  };
  const stopping = x.host.tasks.stop('op');
  assert.equal(x.host.tasks.get('op').state, 'unknown');
  assert.equal(x.host.tasks.get('op').reason, 'worker_error');
  await stopping;
  assert(delivered);
});

test('closing a running backend persists final stop evidence before both processes exit', async t => {
  const x = await setup('running-shutdown'); t.after(x.close);
  await x.host.tasks.submit({ id: 'op', params: params(100) });
  await until(() => x.host.tasks.get('op'), v => v.confirmed >= 1);
  const result = await x.close();
  assert.equal(result.handoffComplete, true); assert.equal(result.childExited, true);
  const business = new DatabaseSync(resolve(x.dataDir, 'business.sqlite'), { readOnly: true });
  const executor = new DatabaseSync(resolve(x.dataDir, 'executor.sqlite'), { readOnly: true });
  try {
    const a = JSON.parse(String(business.prepare('SELECT snapshot FROM tasks WHERE id=?').get('op')!.snapshot));
    const b = JSON.parse(String(executor.prepare('SELECT snapshot FROM executions WHERE id=?').get('op')!.snapshot));
    assert.equal(a.state, 'ended'); assert.equal(a.automation_stopped, true);
    assert.equal(a.seq, b.seq); assert.equal(a.confirmed, b.confirmed);
    assert.equal(result.finalTasks[0].state, a.state);
    assert.equal(result.finalTasks[0].seq, a.seq);
    assert.equal(result.finalTasks[0].confirmed, a.confirmed);
    assert(a.confirmed >= 1 && a.confirmed < 100);
  } finally { business.close(); executor.close(); }
});

test('failed final handoff preserves unknown instead of guessing a completed task', async t => {
  const x = await setup('failed-handoff'); t.after(x.close);
  await x.host.tasks.submit({ id: 'op', params: params(100) });
  await until(() => x.host.tasks.get('op'), v => v.confirmed >= 1);
  const known = x.host.tasks.get('op').confirmed;
  const original = x.host.tasks.adapter.call;
  x.host.tasks.adapter.call = async (path, method, body) => {
    if (path.startsWith('/executions/')) throw new Error('final evidence unavailable');
    return original(path, method, body);
  };
  const closed = await x.close();
  assert.equal(closed.handoffComplete, false); assert.equal(closed.childExited, true);
  assert.equal(closed.finalTasks[0].state, 'unknown');
  const db = new DatabaseSync(resolve(x.dataDir, 'business.sqlite'), { readOnly: true });
  try {
    const final = JSON.parse(String(db.prepare('SELECT snapshot FROM tasks WHERE id=?').get('op')!.snapshot));
    assert.equal(final.state, 'unknown'); assert.equal(final.confirmed, known);
    assert.equal(final.certainty, 'lower_bound'); assert.equal(final.automation_stopped, false);
  } finally { db.close(); }
});

test('a second host cannot take the device, and restarting never resubmits an existing operation', async t => {
  const first = await setup('persistent'); t.after(first.close);
  await first.host.tasks.submit({ id: 'stable', params: params(1) });
  await assert.rejects(setup('persistent'), /Adapter 在就绪前退出/);
  await until(() => first.host.tasks.get('stable'), v => v.state === 'ended');
  assert.equal(first.audit().length, 1);
  assert.equal((await first.close()).childExited, true);
  const restarted = await setup('persistent'); t.after(restarted.close);
  const existing = await restarted.host.tasks.submit({ id: 'stable', params: params(1) });
  assert.equal(existing.state, 'ended'); assert.equal(existing.confirmed, 1);
  assert.equal(restarted.audit().length, 1);
});

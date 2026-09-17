import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.ts';

// 不接受 live 模式；只有脱敏回调参与这些故障实验。
const runId = new Date().toISOString().replaceAll(':', '-');
const root = resolve('.artifacts', `merge-${runId}`);
mkdirSync(root, { recursive: true });
const results: any[] = [];
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
const params = (count = 2) => ({ stage: '1-7', count, medicine: 0, premium: 0 });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check: () => any | Promise<any>, timeout = 8000): Promise<any> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await check(); if (result) return result; await pause(40); }
  throw new Error('等待预期证据超时');
}
function snapshot(data: string) {
  return Object.fromEntries(['business', 'executor'].map(name => {
    const db = new DatabaseSync(join(data, `${name}.sqlite`), { readOnly: true });
    try {
      return [name, Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row =>
        [String(row.name), db.prepare(`SELECT * FROM ${String(row.name)}`).all()]))];
    } finally { db.close(); }
  }));
}
class App {
  child!: ChildProcess;
  ready: any;
  token = randomUUID();
  adapterToken = randomUUID();
  lines: any[] = [];
  data: string;
  directory: string;
  constructor(directory: string) { this.directory = directory; this.data = join(directory, 'data'); }
  async start(faults: object = {}) {
    mkdirSync(this.directory, { recursive: true });
    this.child = spawn(process.execPath, ['src/server.ts'], {
      env: { ...process.env, LAB_BACKEND: 'maa-replay', LAB_DATA: this.data,
        LAB_DEVICE_LOCK: join(this.directory, 'device.lock'), LAB_PYTHON: resolve('.venv/Scripts/python.exe'),
        LAB_APP_TOKEN: this.token, LAB_ADAPTER_TOKEN: this.adapterToken, LAB_PY_FAULTS: JSON.stringify(faults),
        LAB_TS_FAULTS: '{}', LAB_LEASE_MS: '1500', LAB_STOP_DEADLINE_MS: '1500', LAB_POLL_MS: '100',
        LAB_HTTP_TIMEOUT_MS: '450', LAB_DETACHED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    this.child.stderr!.on('data', text => appendFileSync(join(this.directory, 'stderr.log'), text));
    createInterface({ input: this.child.stdout! }).on('line', line => {
      appendFileSync(join(this.directory, 'timeline.jsonl'), line + '\n');
      try { const value = JSON.parse(line); this.lines.push(value); if (value.kind === 'ready') this.ready = value; } catch { /* raw logs */ }
    });
    await until(() => {
      if (this.child.exitCode !== null) throw new Error(`启动失败: ${JSON.stringify(this.lines)}`);
      return this.ready;
    });
    return this;
  }
  async api(path: string, method = 'GET', body?: any, status = 200, adapter = false) {
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-app-token': this.token };
    if (adapter) Object.assign(headers, { 'x-control-token': this.adapterToken,
      'x-controller-id': this.ready.controller, 'x-instance-id': this.ready.adapter.instance });
    const url = adapter ? `http://127.0.0.1:${this.ready.adapter.port}` : this.ready.address;
    const response = await fetch(url + path, { method, headers, signal: AbortSignal.timeout(4000),
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    const value = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    return value;
  }
  submit(count = 2) { return this.api('/tasks', 'POST', { id: 'op', params: params(count) }, 202); }
  async ended() { return until(async () => { const task = await this.api('/tasks/op'); return task.state === 'ended' && task; }); }
  entered() { return readFileSync(join(this.data, 'worker-audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)); }
  async shutdown() {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      await this.api('/shutdown', 'POST', {}, 202);
      await until(() => this.child.exitCode !== null || this.child.signalCode !== null);
    }
  }
}

async function experiment(name: string, body: (app: App) => Promise<any>, faults = {}) {
  const app = new App(join(root, name));
  const entry: any = { name, status: 'running', started: Date.now() };
  try {
    await app.start(faults);
    entry.evidence = await body(app);
    entry.status = 'passed';
  } catch (error) { entry.status = 'failed'; entry.error = String(error); process.exitCode = 1; }
  finally {
    try {
      await app.shutdown();
      await until(() => !alive(app.ready.adapter.pid));
      entry.databases = snapshot(app.data);
      entry.worker_entries = existsSync(join(app.data, 'worker-audit.jsonl')) ? app.entered().length : 0;
      entry.no_leftovers = true;
    } catch (error) {
      entry.status = 'failed'; entry.cleanup_error = String(error); process.exitCode = 1;
      if (app.ready && alive(app.ready.adapter.pid)) process.kill(app.ready.adapter.pid);
      app.child.kill();
    }
    entry.duration_ms = Date.now() - entry.started;
    results.push(entry);
    writeFileSync(join(root, 'results.json'), JSON.stringify({ runId, mode: 'offline_callback_replay', results }, null, 2));
    console.log(`${entry.status}: ${name}${entry.error ? ` ${entry.error}` : ''}`);
  }
}

// 确定性重现已观察到的竞态：停止前发出的轮询，在停止意图落库后才返回。
{
  const store = new Store(join(root, 'stop-intent-regression.sqlite'));
  try {
    store.prepare('op', params());
    store.mark('op', { state: 'stopping', stop_requested: true });
    const delayed = { id: 'op', seq: 1, state: 'running', confirmed: 0, certainty: 'lower_bound', device: 'occupied', reason: null };
    store.apply('op', { instance: 'test', snapshot: delayed,
      events: [{ id: 'op', seq: 1, kind: 'started', source_instance: 'test', snapshot: delayed }] }, () => {});
    assert.equal(store.view('op').state, 'stopping');
    const stopped = { ...delayed, seq: 2, state: 'ended', device: 'needs_check' };
    store.apply('op', { instance: 'test', snapshot: stopped,
      events: [{ id: 'op', seq: 2, kind: 'stopped', source_instance: 'test', snapshot: stopped }] }, () => {});
    assert.equal(store.view('op').state, 'ended');
    results.push({ name: 'stop_intent_survives_delayed_poll', status: 'passed' });
    console.log('passed: stop_intent_survives_delayed_poll');
  } finally { store.db.close(); }
}

await experiment('normal_and_dedup', async app => {
  await app.submit();
  await app.api('/tasks', 'POST', { id: 'op', params: params() });
  await app.api('/executions', 'POST', { id: 'op', params: params() }, 202, true);
  await app.api('/tasks', 'POST', { id: 'op', params: params(3) }, 409);
  await app.api('/tasks', 'POST', { id: 'another', params: params() }, 409);
  const final = await app.ended();
  assert.equal(final.confirmed, 2); assert.equal(final.certainty, 'exact');
  assert.equal(final.automation_stopped, true); assert.equal(final.gap, false);
  assert.equal(final.device, 'needs_check');
  const replay = await app.api('/lab/replay/op', 'POST');
  assert.equal(replay.confirmed, 2); assert.equal(replay.cursor, final.cursor);
  await app.api('/tasks', 'POST', { id: 'next', params: params() }, 409);
  await app.api('/reconcile', 'POST', {}, 409);
  assert.equal(app.entered().length, 1);
  return final;
});

await experiment('stop_during_unsettled_cycle', async app => {
  await app.submit();
  await until(async () => (await app.api('/tasks/op')).started_cycles === 1);
  const response = await app.api('/tasks/op/stop', 'POST', {}, 202);
  assert.equal(response.confirmed, false);
  const begin = Date.now();
  await app.api('/health');
  assert(Date.now() - begin < 700, '停止等待期间 HTTP 仍响应');
  const pending = await app.api('/tasks/op');
  assert.equal(pending.state, 'stopping'); assert.equal(pending.automation_stopped, false);
  const final = await app.ended();
  assert.equal(final.confirmed, 0); assert.equal(final.certainty, 'lower_bound');
  assert.equal(final.unsettled_cycles, 1); assert.equal(final.automation_stopped, true);
  return { response, pending, final };
}, { tick_ms: 240, stop_delay_ms: 900 });

await experiment('lost_submission_response', async app => {
  await app.submit();
  const final = await app.ended();
  await app.api('/tasks', 'POST', { id: 'op', params: params() });
  assert.equal(app.entered().length, 1); assert.equal(final.confirmed, 2);
  return final;
}, { drop_response: true });

await experiment('invalid_settlement', async app => {
  await app.submit();
  const final = await app.ended();
  assert.equal(final.confirmed, 0); assert.equal(final.certainty, 'lower_bound');
  assert.equal(final.started_cycles, 1); assert.equal(final.automation_stopped, true);
  return final;
}, { invalid_drop: true });

await experiment('sqlite_failure_still_stops', async app => {
  await app.submit();
  await until(async () => (await app.api('/tasks/op')).started_cycles === 1);
  await app.api('/lab/faults', 'POST', { storage_readonly: true }, 200, true);
  await app.api('/tasks/op/stop', 'POST', {}, 202);
  const task = await until(async () => { const value = await app.api('/tasks/op'); return value.state === 'unknown' && value; });
  assert.equal(task.certainty, 'lower_bound'); assert.equal(task.device, 'needs_check');
  await until(async () => (await app.api('/health', 'GET', undefined, 200, true)).active.length === 0);
  assert.equal(app.entered().length, 1);
  return task;
}, { tick_ms: 180 });

await experiment('lease_exit_and_no_restart_replay', async app => {
  await app.submit(3);
  await until(async () => (await app.api('/tasks/op')).started_cycles === 1);
  const oldPid = app.ready.adapter.pid;
  app.child.kill();
  await until(() => app.child.exitCode !== null || app.child.signalCode !== null);
  await until(() => !alive(oldPid));
  const before = snapshot(app.data);
  assert(readFileSync(join(app.data, 'executor-trace.jsonl'), 'utf8').includes('lease_expired'));
  app.ready = undefined;
  await app.start();
  await app.api('/tasks', 'POST', { id: 'op', params: params(3) });
  const task = await until(async () => { const value = await app.api('/tasks/op'); return value.state === 'ended' && value; });
  assert.equal(task.certainty, 'lower_bound'); assert.equal(task.device, 'needs_check');
  assert.equal(app.entered().length, 1);
  return { before, task };
}, { tick_ms: 600 });

await experiment('executor_crash_keeps_unknown', async app => {
  await app.submit();
  await until(async () => (await app.api('/tasks/op')).started_cycles === 1);
  process.kill(app.ready.adapter.pid); // 仅本轮离线替身的精确 PID。
  await until(async () => (await app.api('/health')).childExited);
  await app.shutdown();
  app.ready = undefined;
  await app.start();
  await app.api('/tasks', 'POST', { id: 'op', params: params() });
  const task = await until(async () => { const value = await app.api('/tasks/op'); return value.reason === 'executor_restarted' && value; });
  assert.equal(task.state, 'unknown'); assert.equal(task.device, 'needs_check');
  assert.equal(task.certainty, 'lower_bound'); assert.equal(task.automation_stopped, false);
  await app.api('/reconcile', 'POST', {}, 409);
  await app.api('/tasks', 'POST', { id: 'next', params: params() }, 409);
  assert.equal(app.entered().length, 1);
  return task;
}, { tick_ms: 400 });

console.log(`证据: ${root}`);

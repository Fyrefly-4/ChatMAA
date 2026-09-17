import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { pythonRuntime } from '../src/python-runtime.ts';
import { release } from 'node:os';

const python = process.env.LAB_PYTHON ?? resolve('.venv/Scripts/python.exe');
assert(existsSync(python), 'Set LAB_PYTHON to Python with requirements.lock installed');
const runtime = pythonRuntime(python);
const runId = new Date().toISOString().replaceAll(':', '-');
const root = resolve('.artifacts', runId);
mkdirSync(root, { recursive: true });
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
const config = { lease_ms: 1500, stop_deadline_ms: 900, poll_ms: 150, http_timeout_ms: 450 };
const results: any[] = [];
let current: any;
let processes: ChildProcess[] = [];
let apps: LabApp[] = [];
let suspensions: ChildProcess[] = [];
const oracleEvents: any[] = [];
const oracle = createServer(socket => {
  socket.on('error', () => {}); // 被测执行器可能在 ACK 附近被终止。
  let buffer = '';
  socket.on('data', data => {
    buffer += data;
    const newline = buffer.indexOf('\n');
    if (newline === -1) return;
    const event = JSON.parse(buffer.slice(0, newline));
    oracleEvents.push(event);
    const file = join(current.directory, 'oracle.jsonl');
    appendFileSync(file, JSON.stringify(event) + '\n');
    const fd = openSync(file, 'r+'); fsyncSync(fd); closeSync(fd);
    socket.end('ok\n');
  });
});
oracle.listen(0, '127.0.0.1');
await once(oracle, 'listening');
const oraclePort = (oracle.address() as { port: number }).port;

async function until(check: () => any | Promise<any>, label: string, timeout = 7000) {
  const end = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < end) {
    try { const result = await check(); if (result) return result; } catch (error) { last = error; }
    await pause(50);
  }
  throw new Error(`${label}: timeout; ${String(last ?? '')}`);
}
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
function rows(file: string) {
  if (!existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    return Object.fromEntries(tables.map(t => [String(t.name), db.prepare(`SELECT * FROM ${String(t.name)}`).all()]));
  } finally { db.close(); }
}
function capture(label: string) {
  const snapshot = { label, at: Date.now(), databases: [...new Set(apps.map(a => a.data))].map((path, index) => ({
    index, business: rows(join(path, 'business.sqlite')), executor: rows(join(path, 'executor.sqlite')),
  })) };
  current.snapshots.push(snapshot);
  writeFileSync(join(current.directory, 'snapshots.json'), JSON.stringify(current.snapshots, null, 2));
}
class LabApp {
  process!: ChildProcess;
  data: string;
  device: string;
  appToken = randomUUID();
  adapterToken = randomUUID();
  ready: any;
  lines: any[] = [];
  constructor(data?: string, device?: string) {
    this.data = data ?? join(current.directory, 'data');
    this.device = device ?? join(current.directory, 'device.lock');
  }
  async start(pyFaults = {}, tsFaults = {}, expectBusy = false, detached = true) {
    apps.push(this);
    this.process = spawn(process.execPath, ['src/server.ts'], {
      env: { ...process.env, LAB_DATA: this.data, LAB_DEVICE_LOCK: this.device,
        LAB_PYTHON: python, LAB_APP_TOKEN: this.appToken, LAB_ADAPTER_TOKEN: this.adapterToken,
        LAB_ORACLE_PORT: String(oraclePort), LAB_PY_FAULTS: JSON.stringify(pyFaults), LAB_TS_FAULTS: JSON.stringify(tsFaults),
        LAB_LEASE_MS: String(config.lease_ms), LAB_STOP_DEADLINE_MS: String(config.stop_deadline_ms),
        LAB_POLL_MS: String(config.poll_ms), LAB_HTTP_TIMEOUT_MS: String(config.http_timeout_ms), LAB_DETACHED: detached ? '1' : '0' },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    processes.push(this.process);
    this.process.stderr!.on('data', data => appendFileSync(join(current.directory, 'stderr.log'), data));
    this.process.on('error', error => this.lines.push({ kind: 'spawn_error', error: String(error) }));
    createInterface({ input: this.process.stdout! }).on('line', line => {
      try {
        const value = JSON.parse(line);
        this.lines.push(value);
        appendFileSync(join(current.directory, 'timeline.jsonl'), line + '\n');
        if (value.kind === 'ready') this.ready = value;
      } catch { /* 非结构化运行时日志留在 stderr */ }
    });
    if (expectBusy) {
      await until(() => this.process.exitCode !== null, 'second instance exits');
      assert.equal(this.process.exitCode, 24);
      assert(this.lines.some(l => l.kind === 'adapter' && l.message.kind === 'device_busy'));
    } else {
      await until(() => {
        if (this.process.exitCode !== null) throw new Error(JSON.stringify(this.lines));
        return this.ready;
      }, 'application ready');
      await until(() => this.api('/health'), 'HTTP ready');
    }
    return this;
  }
  async api(path: string, method = 'GET', body?: any, expected?: number) {
    const response = await fetch(this.ready.address + path, {
      method, headers: { 'content-type': 'application/json', 'x-app-token': this.appToken },
      body: body === undefined ? (method === 'POST' ? '{}' : undefined) : JSON.stringify(body), signal: AbortSignal.timeout(4000),
    });
    const value = await response.json();
    if (expected !== undefined) assert.equal(response.status, expected, JSON.stringify(value));
    else assert(response.ok, `${response.status}: ${JSON.stringify(value)}`);
    return value;
  }
  async adapter(path: string, method = 'GET', body?: any, expected?: number, identity: any = {}) {
    const response = await fetch(`http://127.0.0.1:${this.ready.adapter.port}${path}`, {
      method, headers: { 'content-type': 'application/json', 'x-control-token': this.adapterToken,
        'x-controller-id': this.ready.controller, 'x-instance-id': this.ready.adapter.instance, ...identity },
      body: body === undefined ? (method === 'POST' ? '{}' : undefined) : JSON.stringify(body), signal: AbortSignal.timeout(700),
    });
    const value = await response.json();
    if (expected !== undefined) assert.equal(response.status, expected, JSON.stringify(value));
    else assert(response.ok, JSON.stringify(value));
    return value;
  }
  submit(id = 'op', count = 30) { return this.api('/tasks', 'POST', { id, params: params(count) }); }
  async ended(id = 'op') { return until(async () => { const task = await this.api(`/tasks/${id}`); return task.state === 'ended' && task; }, 'task ended'); }
  async shutdown() {
    if (this.process.exitCode !== null) return;
    await this.api('/shutdown', 'POST');
    await until(() => this.process.exitCode !== null || this.process.signalCode !== null, 'application exited');
  }
}
function params(count = 30) { return { stage: '1-7', count, medicine: 0, premium: 0 }; }
function observations(kind: string, id = 'op') { return oracleEvents.filter(e => e.kind === kind && e.id === id); }
async function suspend(pid: number) {
  assert(apps.some(a => a.process.pid === pid || a.ready?.adapter.pid === pid), 'only own laboratory processes');
  const child = spawn(runtime.executable, ['-S', 'experiments/suspend.py', String(pid)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  processes.push(child); suspensions.push(child);
  child.stderr!.on('data', data => appendFileSync(join(current.directory, 'stderr.log'), data));
  let ready = false;
  child.stdout!.on('data', () => { ready = true; });
  await until(() => ready, 'process suspended');
  return child;
}
async function resume(child: ChildProcess) { child.stdin!.end('\n'); await until(() => child.exitCode !== null, 'process resumed'); }
async function cleanup() {
  for (const child of suspensions) if (child.exitCode === null) child.stdin!.end('\n');
  await pause(100);
  for (const app of apps) {
    try { if (app.ready && app.process.exitCode === null && app.process.signalCode === null) await app.shutdown(); } catch { /* 精确 PID 清理兜底 */ }
    if (app.ready && alive(app.ready.adapter.pid)) process.kill(app.ready.adapter.pid);
  }
  for (const child of processes) if (child.exitCode === null && child.signalCode === null) child.kill();
  await until(() => apps.every(a => !a.ready || !alive(a.ready.adapter.pid)), 'no executor leftovers');
}
async function experiment(name: string, run: () => Promise<void>) {
  current = { name, directory: join(root, name), snapshots: [], status: 'running', started: Date.now() };
  mkdirSync(current.directory, { recursive: true });
  oracleEvents.length = 0; apps = []; processes = []; suspensions = [];
  try {
    await run();
    current.status = 'passed';
  } catch (error) {
    current.status = 'failed'; current.error = String(error); process.exitCode = 1;
  } finally {
    try { capture('before_cleanup'); await cleanup(); capture('after_cleanup'); }
    catch (error) { current.status = 'failed'; current.cleanup_error = String(error); process.exitCode = 1; }
    current.duration_ms = Date.now() - current.started;
    current.oracle = [...oracleEvents];
    current.timeline = apps.flatMap(a => a.lines);
    const { directory, ...portable } = current;
    results.push(portable);
    writeFileSync(join(root, 'results.json'), JSON.stringify({ runId, config, results }, null, 2));
    console.log(`${current.status}: ${name} (${current.duration_ms} ms)${current.error ? ' ' + current.error : ''}`);
  }
}

await experiment('01_normal_and_stop', async () => {
  const app = await new LabApp().start();
  capture('empty');
  await app.submit();
  await until(() => observations('success').length >= 1, 'one confirmed success');
  const before = await app.api('/tasks/op');
  capture('running');
  const stop = await app.api('/tasks/op/stop', 'POST');
  assert.equal(stop.confirmed, false);
  await app.api('/tasks', 'POST', { id: 'other', params: params() }, 409);
  const ended = await app.ended();
  assert.equal(ended.reason, 'stopped'); assert.equal(ended.certainty, 'exact');
  assert(ended.confirmed >= before.confirmed);
  assert.equal(observations('start').length, 1);
  await app.submit('next', 2);
  assert.equal((await app.ended('next')).confirmed, 2);
});
await experiment('02_identity_concurrency_and_validation', async () => {
  const app = await new LabApp().start();
  await app.api('/tasks', 'POST', { id: 'bad', params: { ...params(), medicine: 1 } }, 400);
  await app.api('/tasks', 'POST', { id: 'bad', params: { ...params(), count: '3' } }, 400);
  await Promise.all(Array.from({ length: 8 }, () => app.submit()));
  await app.api('/tasks', 'POST', { id: 'op', params: params(4) }, 409);
  await Promise.all(Array.from({ length: 5 }, () => app.adapter('/executions', 'POST', { id: 'op', params: params() })));
  await app.adapter('/executions', 'POST', { id: 'op', params: params(4) }, 409);
  await app.adapter('/executions', 'POST', { id: 'other', params: params() }, 409);
  await app.adapter('/executions', 'POST', { id: 'bad', params: { ...params(), premium: 1 } }, 422);
  await app.adapter('/lease', 'POST', undefined, 403, { 'x-controller-id': 'stale-controller' });
  await app.adapter('/lease', 'POST', undefined, 403, { 'x-instance-id': 'stale-instance' });
  await app.adapter('/executions', 'POST', { id: 'stale', params: params() }, 403, { 'x-controller-id': 'stale-controller' });
  assert.equal(observations('start').length, 1);
});
await experiment('03_lost_submission_response', async () => {
  const app = await new LabApp().start({ drop_response: true });
  await app.submit();
  await app.submit();
  await until(async () => (await app.api('/tasks/op')).confirmed >= 1, 'query reconciles accepted submission');
  assert.equal(observations('start').length, 1);
});
await experiment('04_second_instance', async () => {
  const app = await new LabApp().start();
  await app.submit();
  await new LabApp(join(current.directory, 'second-data'), app.device).start({}, {}, true);
  await new LabApp(app.data, app.device).start({}, {}, true);
  assert.equal((await app.api('/tasks/op')).state, 'running');
  assert.equal(observations('start').length, 1);
});
await experiment('05_duplicate_events', async () => {
  const app = await new LabApp().start();
  await app.submit('op', 2); await app.ended();
  capture('before_replay');
  const before = await app.api('/tasks/op');
  for (let i = 0; i < 3; i++) await app.api('/lab/replay/op', 'POST');
  assert.deepEqual(await app.api('/tasks/op'), before);
  const db = rows(join(app.data, 'business.sqlite'))!;
  assert.equal(db.evidence.length, before.cursor);
});
await experiment('06_event_gap_and_new_explicit_task', async () => {
  const app = await new LabApp().start({ omit_seq: 2 });
  await app.submit('op', 2);
  const ended = await app.ended();
  assert.equal(ended.gap, true); assert.equal(ended.certainty, 'lower_bound');
  assert.equal(ended.device, 'ready');
  await app.submit('new-explicit', 1); await app.ended('new-explicit');
});
for (const point of ['before_accept', 'after_accept', 'before_start', 'after_start', 'before_success_record', 'after_success_record']) {
  await experiment(`07_python_crash_${point}`, async () => {
    const app = await new LabApp().start({ crash: point });
    capture('before_submission');
    await app.submit();
    await until(() => !alive(app.ready.adapter.pid), 'executor crashed');
    capture('after_crash');
    assert.equal(observations('start').length, ['before_accept', 'after_accept', 'before_start'].includes(point) ? 0 : 1);
    await app.shutdown();
    const recovered = await new LabApp(app.data, app.device).start();
    await recovered.submit(); // 查询原操作，禁止自动重新执行。
    if (point !== 'before_accept') await recovered.adapter('/executions', 'POST', { id: 'op', params: params() });
    assert.notEqual((await recovered.api('/tasks/op')).certainty, 'exact');
    if (point === 'after_success_record') {
      await until(async () => (await recovered.api('/tasks/op')).confirmed === 1, 'durable success retained');
    }
    if (point === 'before_success_record') assert.equal((await recovered.api('/tasks/op')).confirmed, 0);
    await recovered.api('/tasks', 'POST', { id: 'conflict', params: params() }, 409);
    const starts = observations('start').length;
    await recovered.api('/reconcile', 'POST');
    assert.equal((await recovered.api('/tasks/op')).state, 'ended');
    assert.equal((await recovered.api('/tasks/op')).certainty, 'lower_bound');
    await recovered.submit();
    assert.equal(observations('start').length, starts);
    await recovered.submit('explicit-new', 1); await recovered.ended('explicit-new');
  });
}
for (const point of ['after_intent', 'before_projection_commit', 'after_projection_commit']) {
  await experiment(`08_ts_crash_${point}`, async () => {
    const app = await new LabApp().start({}, { crash: point, after_confirmed: point === 'after_intent' ? 0 : 1 });
    await app.submit().catch(() => {});
    await until(() => app.process.exitCode !== null, 'TS crashed');
    capture('after_crash');
    const dbBefore = rows(join(app.data, 'business.sqlite'))!;
    if (point === 'before_projection_commit') {
      assert(dbBefore.evidence.every(e => JSON.parse(String(e.body)).kind !== 'success'));
      assert.equal(JSON.parse(String(dbBefore.tasks[0].snapshot)).confirmed, 0);
    }
    if (point === 'after_projection_commit') assert.equal(JSON.parse(String(dbBefore.tasks[0].snapshot)).confirmed, 1);
    await until(() => !alive(app.ready.adapter.pid), 'Python lease expiry cleanup');
    const starts = observations('start').length;
    const recovered = await new LabApp(app.data, app.device).start();
    await recovered.submit();
    await recovered.api('/reconcile', 'POST');
    await until(async () => (await recovered.api('/tasks/op')).state === 'ended', 'recovered projection');
    assert.equal(observations('start').length, starts);
    const task = await recovered.api('/tasks/op');
    if (point !== 'after_intent') {
      assert.equal(task.confirmed, observations('success').length);
      assert.equal(rows(join(app.data, 'business.sqlite'))!.evidence.length, task.cursor);
    }
  });
}
await experiment('09_ts_hung_lease_expires', async () => {
  const app = await new LabApp().start();
  await app.submit();
  const frozen = await suspend(app.process.pid!);
  assert(alive(app.process.pid!));
  await until(() => !alive(app.ready.adapter.pid), 'healthy Python stops after controller hangs');
  assert(observations('stop').length >= 1);
  await resume(frozen);
});
await experiment('10_no_progress_is_not_control_loss', async () => {
  const app = await new LabApp().start({ tick_ms: 3500 });
  await app.submit();
  await pause(2000);
  assert(alive(app.ready.adapter.pid));
  assert.equal(observations('success').length, 0);
  assert.equal((await app.api('/tasks/op')).state, 'running');
});
await experiment('11_stop_blocked_parent_alive', async () => {
  const app = await new LabApp().start({ block_stop: true });
  await app.submit();
  await app.api('/tasks/op/stop', 'POST');
  await pause(1200);
  assert(alive(app.ready.adapter.pid)); // 普通停止不能升级强杀。
  assert.equal((await app.api('/tasks/op')).state, 'stopping');
  await app.api('/tasks', 'POST', { id: 'new', params: params() }, 409);
  await app.shutdown();
  assert(!alive(app.ready.adapter.pid));
  assert(app.lines.some(l => l.kind === 'adapter' && l.message.kind === 'forced_self_exit'));
});
await experiment('12_stop_blocked_parent_dead', async () => {
  const app = await new LabApp().start({ block_stop: true });
  await app.submit(); app.process.kill();
  await until(() => !alive(app.ready.adapter.pid), 'Python self exits after failed stop');
  assert(readFileSync(join(app.data, 'executor-trace.jsonl'), 'utf8').includes('forced_self_exit'));
});
await experiment('13_whole_python_hung_parent_alive', async () => {
  const app = await new LabApp().start();
  await app.submit();
  const frozen = await suspend(app.ready.adapter.pid);
  await assert.rejects(app.adapter('/health'));
  await app.shutdown();
  assert(!alive(app.ready.adapter.pid));
  assert(app.lines.some(l => l.kind === 'force_child'));
  await resume(frozen);
});
await experiment('14_both_unresponsive_known_gap', async () => {
  const app = await new LabApp().start();
  await app.submit();
  const frozen = await suspend(app.ready.adapter.pid);
  app.process.kill();
  await pause(config.lease_ms + config.stop_deadline_ms + 700);
  assert(alive(app.ready.adapter.pid)); // 实证缺口；通过表示发现限制，不表示有兜底。
  await assert.rejects(app.adapter('/health'));
  current.limitation = 'TS 已死且整个 Python 挂起时，双进程结构不能保证终止；实验驱动恢复它才可清理。';
  await resume(frozen);
  await until(() => !alive(app.ready.adapter.pid), 'cleanup after external resume');
});
await experiment('15_python_storage_failure_stop_still_reaches', async () => {
  const app = await new LabApp().start({ tick_ms: 700 });
  await app.submit();
  await app.adapter('/lab/faults', 'POST', { storage_readonly: true });
  await app.api('/tasks/op/stop', 'POST');
  await until(() => observations('stop').length > 0, 'stop delivered despite SQLite write failure');
  await app.api('/tasks', 'POST', { id: 'new', params: params() }, 409);
  await until(async () => (await app.api('/tasks/op')).certainty === 'lower_bound', 'unknown retained');
});
await experiment('16_ts_storage_failure_stop_still_reaches', async () => {
  const app = await new LabApp().start();
  await app.submit();
  await app.api('/lab/faults', 'POST', { storage_readonly: true });
  await app.api('/tasks/op/stop', 'POST');
  await until(() => observations('stop').length > 0, 'stop bypasses business storage failure');
  await app.api('/tasks', 'POST', { id: 'new', params: params() }, 503);
});
await experiment('17_failure_does_not_retry', async () => {
  const app = await new LabApp().start({ fail_after: 2 });
  await app.submit('op', 10);
  const ended = await app.ended();
  assert.equal(ended.confirmed, 2); assert.equal(ended.reason, 'simulated_failure');
  await pause(450);
  assert.equal(observations('success').length, 2); assert.equal(observations('start').length, 1);
});
await experiment('18_windows_default_spawn_comparison', async () => {
  const app = await new LabApp().start({}, {}, false, false);
  await app.submit(); app.process.kill();
  await until(() => !alive(app.ready.adapter.pid), 'default Windows spawn kills child with parent');
  const lifecycle = readFileSync(join(app.data, 'executor-trace.jsonl'), 'utf8');
  assert(!lifecycle.includes('lease_expired'));
  assert(!lifecycle.includes('stop_confirmed'));
  current.limitation = '默认 spawn 的 Windows Job 在 TS 退出时立即终止子进程；不能把这种清理当作先正常停止。';
});

oracle.close();
const pythonInfo = spawnSync(runtime.executable, ['-S', '-c',
  'import json,platform,sqlite3,fastapi,uvicorn; print(json.dumps({"python":platform.python_version(),"sqlite":sqlite3.sqlite_version,"fastapi":fastapi.__version__,"uvicorn":uvicorn.__version__}))'],
{ env: { ...process.env, PYTHONPATH: runtime.site }, encoding: 'utf8', windowsHide: true });
assert.equal(pythonInfo.status, 0, pythonInfo.stderr);
const db = new DatabaseSync(':memory:');
const nodeSqlite = db.prepare('SELECT sqlite_version() AS version').get()!.version;
db.close();
const report = { runId, platform: process.platform, os_release: release(), arch: process.arch,
  node: process.version, node_sqlite: nodeSqlite, python: JSON.parse(pythonInfo.stdout),
  dependencies: JSON.parse(readFileSync('package.json', 'utf8')).dependencies, config, results };
writeFileSync(join(root, 'results.json'), JSON.stringify(report, null, 2));
writeFileSync(resolve('.artifacts/latest.json'), JSON.stringify({ run: runId, path: join(root, 'results.json') }, null, 2));
console.log(`Evidence: ${root}`);
console.log(`${results.filter(r => r.status === 'passed').length}/${results.length} experiments passed; real MAA not invoked.`);

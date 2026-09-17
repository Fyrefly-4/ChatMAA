import Fastify from 'fastify';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { Store } from './store.ts';
import type { Params, Update } from './store.ts';
import { pythonRuntime } from './python-runtime.ts';

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required; use the experiment driver`);
  return value;
}
const data = resolve(required('LAB_DATA'));
mkdirSync(data, { recursive: true });
const token = required('LAB_APP_TOKEN');
const adapterToken = required('LAB_ADAPTER_TOKEN');
const controller = randomUUID();
const interval = Number(process.env.LAB_POLL_MS ?? 150);
const requestTimeout = Number(process.env.LAB_HTTP_TIMEOUT_MS ?? 450);
const deadline = Number(process.env.LAB_STOP_DEADLINE_MS ?? 900);
let store: Store;
const faults: Record<string, unknown> = JSON.parse(process.env.LAB_TS_FAULTS ?? '{}');
const app = Fastify({ logger: false, ajv: { customOptions: { coerceTypes: false, removeAdditional: false } } });
let closing = false;
let syncing = false;
let storageFailed = false;
let childExited = false;
let adapter: { port: number; instance: string; pid: number };
function trace(kind: string, values: object = {}) { console.log(JSON.stringify({ kind, at: Date.now(), ...values })); }
function checkpoint(name: string) {
  if (faults.crash === name) {
    trace('crash', { point: name });
    process.exit(81);
  }
}
class HttpFailure extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
async function call(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(`http://127.0.0.1:${adapter.port}${path}`, {
    method, signal: AbortSignal.timeout(requestTimeout),
    headers: { 'content-type': 'application/json', 'x-control-token': adapterToken,
      'x-controller-id': controller, 'x-instance-id': adapter.instance },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new HttpFailure(response.status, JSON.stringify(value));
  return value;
}

const runtime = pythonRuntime(required('LAB_PYTHON'));
const child: ChildProcess = spawn(runtime.executable, ['-S', '-u', resolve('adapter/service.py')], {
  env: { ...process.env, PYTHONPATH: runtime.site, LAB_DATA: data, LAB_CONTROLLER: controller },
  // 保留进程句柄与显式启停；不 unref。避免 Windows 默认 Job 在 TS 崩溃时
  // 立即杀死 Python，使其有机会按租约先正常停止，再按期限退出。
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.env.LAB_DETACHED !== '0',
});
child.stderr!.on('data', chunk => process.stderr.write(chunk));
child.on('exit', (code, signal) => {
  childExited = true;
  trace('child_exit', { pid: child.pid, code, signal });
  for (const task of store?.all() ?? []) {
    if (JSON.parse(task.snapshot).state !== 'ended') {
      try { store.mark(task.id, { state: 'unknown', certainty: 'lower_bound', device: 'needs_check', reason: 'executor_exited' }); }
      catch { storageFailed = true; }
    }
  }
});
try {
  adapter = await new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error('adapter startup timeout')), 8000);
    child.once('error', error => { clearTimeout(timer); fail(error); });
    child.once('exit', code => { clearTimeout(timer); fail(new Error(`adapter exited before ready: ${code}`)); });
    createInterface({ input: child.stdout! }).on('line', line => {
      try {
        const message = JSON.parse(line);
        trace('adapter', { message });
        if (message.kind === 'ready') {
          clearTimeout(timer);
          if (message.pid !== child.pid) fail(new Error('spawned PID differs from executor PID'));
          else ok(message);
        }
      } catch { trace('adapter_log', { line }); }
    });
  });
} catch (error) {
  child.kill();
  trace('startup_failed', { error: String(error) });
  process.exit(24);
}
// 取得设备占用后才打开业务库，避免第二实例在退出时改写第一实例的任务。
store = new Store(resolve(data, 'business.sqlite'));

async function sync(id: string, replay = false) {
  if (faults.disk_full) { storageFailed = true; throw new Error('injected storage failure'); }
  const row = store.get(id)!;
  const update = await call(`/executions/${id}?after=${replay ? 0 : row.cursor}`) as Update;
  if (update.instance !== adapter.instance) throw new Error('wrong adapter instance');
  if (childExited && update.snapshot.state !== 'ended') {
    update.snapshot = { ...update.snapshot, state: 'unknown', certainty: 'lower_bound', device: 'needs_check', reason: 'executor_exited' };
  }
  try {
    store.apply(id, update, name => {
      if (update.snapshot.confirmed >= Number(faults.after_confirmed ?? 0)) checkpoint(name);
    });
  } catch (error) {
    storageFailed = true;
    throw error;
  }
}
// 控制权续期不依赖执行进度，也不与证据投影共用可能失败的事务。
const heartbeat = setInterval(() => {
  if (!closing && !childExited) call('/lease', 'POST').catch(() => {});
}, interval);
const polling = setInterval(async () => {
  if (closing || syncing || childExited) return;
  syncing = true;
  try {
    for (const task of store.all()) {
      if (JSON.parse(task.snapshot).state === 'rejected') continue;
      try { await sync(task.id); } catch (error) {
        if (error instanceof HttpFailure && error.status === 404) continue;
        trace('sync_unavailable', { id: task.id, error: String(error) });
      }
    }
  } finally { syncing = false; }
}, interval);

app.addHook('onRequest', async (request, reply) => {
  const provided = request.headers['x-app-token'];
  if (request.headers.origin || typeof provided !== 'string' ||
      Buffer.byteLength(provided) !== Buffer.byteLength(token) ||
      !timingSafeEqual(Buffer.from(provided), Buffer.from(token))) {
    return reply.code(403).send({ error: 'unauthorized' });
  }
});
const paramsSchema = { type: 'object', additionalProperties: false,
  required: ['stage', 'count', 'medicine', 'premium'], properties: {
    stage: { type: 'string', const: '1-7' }, count: { type: 'integer', minimum: 1, maximum: 100 },
    medicine: { type: 'integer', const: 0 }, premium: { type: 'integer', const: 0 },
  } };
app.post<{ Body: { id: string; params: Params } }>('/tasks', { schema: { body: {
  type: 'object', additionalProperties: false, required: ['id', 'params'],
  properties: { id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,80}$' }, params: paramsSchema },
} } }, async (request, reply) => {
  const { id, params: raw } = request.body;
  const params = { stage: raw.stage, count: raw.count, medicine: raw.medicine, premium: raw.premium };
  const existing = store.get(id);
  if (existing) {
    if (existing.params !== JSON.stringify(params)) return reply.code(409).send({ error: 'id_parameter_conflict' });
    return store.view(id); // 重启或网络故障后也不自动重发。
  }
  if (closing || childExited || storageFailed || faults.disk_full) return reply.code(503).send({ error: 'not_ready' });
  if (store.all().some(t => !['ended', 'rejected'].includes(JSON.parse(t.snapshot).state))) {
    return reply.code(409).send({ error: 'device_busy_or_uncertain' });
  }
  try { store.prepare(id, params); } catch { storageFailed = true; return reply.code(503).send({ error: 'storage_unavailable' }); }
  checkpoint('after_intent');
  try {
    await call('/executions', 'POST', { id, params });
    await sync(id);
  } catch (error) {
    if (error instanceof HttpFailure && [409, 422].includes(error.status)) {
      store.mark(id, { state: 'rejected', device: 'ready', reason: error.message });
      return reply.code(409).send(store.view(id));
    }
    trace('submission_uncertain', { id, error: String(error) });
  }
  return reply.code(202).send(store.view(id));
});
app.get('/health', async () => ({ controller, adapter, childExited, storageFailed, closing }));
app.get('/tasks', async () => store.all().map(t => store.view(t.id)));
app.get<{ Params: { id: string } }>('/tasks/:id', async (request, reply) => {
  return store.view(request.params.id) ?? reply.code(404).send({ error: 'unknown_task' });
});
app.post<{ Params: { id: string } }>('/tasks/:id/stop', async (request, reply) => {
  const id = request.params.id;
  if (!store.get(id)) return reply.code(404).send({ error: 'unknown_task' });
  // 停止不依赖写入成功。请求返回不是停止确认。
  if (!faults.disk_full) {
    try { store.mark(id, { state: 'stopping', device: 'occupied', reason: 'stop_requested' }); }
    catch { storageFailed = true; }
  }
  try { await call(`/executions/${id}/stop`, 'POST'); } catch { /* 保留停止未确认 */ }
  return reply.code(202).send({ id, stop_requested: true, confirmed: false });
});
app.post('/reconcile', async (_request, reply) => {
  try {
    const result = await call('/reconcile', 'POST');
    for (const task of store.all()) {
      try { await sync(task.id); } catch (error) {
        if (error instanceof HttpFailure && error.status === 404) {
          // 此证明只适用于没有外部动作的替身，且由新实例持有同一设备锁。
          store.mark(task.id, { state: 'ended', device: 'ready', certainty: 'lower_bound', reason: 'fake_environment_checked_no_record' });
        } else throw error;
      }
    }
    return result;
  } catch (error) { return reply.code(409).send({ error: String(error) }); }
});
app.post<{ Body: Record<string, unknown> }>('/lab/faults', async request => {
  Object.assign(faults, request.body);
  if (request.body.storage_readonly) store.db.exec('PRAGMA query_only=ON');
  return { configured: true };
});
app.post<{ Params: { id: string } }>('/lab/replay/:id', async request => { await sync(request.params.id, true); return store.view(request.params.id); });

async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(heartbeat);
  clearInterval(polling);
  try { await call('/shutdown', 'POST'); } catch { /* 超时后仅终止自己创建的 child */ }
  const until = Date.now() + deadline + 500;
  while (!childExited && Date.now() < until) await new Promise(r => setTimeout(r, 30));
  if (!childExited) {
    trace('force_child', { pid: child.pid });
    child.kill();
    const exitDeadline = Date.now() + 3000;
    while (!childExited && Date.now() < exitDeadline) await new Promise(r => setTimeout(r, 30));
  }
  if (!childExited) { trace('child_exit_unconfirmed'); return; }
  await app.close();
  store.db.close();
  process.exit(0);
}
app.post('/shutdown', async (_request, reply) => {
  reply.code(202).send({ shutting_down: true });
  setTimeout(() => { void shutdown(); }, 10);
});
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
// 某些 Windows 环境的自动端口范围包含 fetch 禁用端口（实测遇到 2049）。
// 实际 bind 选择较高端口，冲突时重试，不做先探测再绑定的检查。
let address = '';
for (let attempt = 0; attempt < 30; attempt++) {
  try { address = await app.listen({ host: '127.0.0.1', port: randomInt(20000, 60000) }); break; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error; }
}
if (!address) { await shutdown(); throw new Error('no local HTTP port available'); }
trace('ready', { address, controller, adapter, pid: process.pid });

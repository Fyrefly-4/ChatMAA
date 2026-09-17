import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

// --replay 可以验证同一交接驱动，但绝不加载 MaaCore；live 必须显式提供一次性配置。
const replay = process.argv.includes('--replay');
const grantArgument = process.argv.indexOf('--grant');
if (!replay && (!process.argv.includes('--live') || grantArgument < 0)) {
  throw new Error('使用已说明的管理员入口；离线检查必须显式加 --replay');
}
const grantPath = grantArgument < 0 ? '' : resolve(process.argv[grantArgument + 1]!);
const grant = replay ? {
  kind: 'manual_http_experiment', id: 'offline-handoff',
  data: resolve('.artifacts', `handoff-${new Date().toISOString().replaceAll(':', '-')}`),
  params: { stage: '1-7', count: 2, medicine: 0, premium: 0 }, stop_after_started_cycles: 2,
} : JSON.parse(readFileSync(grantPath, 'utf8'));
assert.deepEqual(grant.params, { stage: '1-7', count: 2, medicine: 0, premium: 0 });
assert.equal(grant.stop_after_started_cycles, 2);
assert.equal(grant.kind, 'manual_http_experiment');
assert(!existsSync(grant.data), '本轮已有记录，不能重复启动');
mkdirSync(grant.data);
const token = randomUUID();
const adapterToken = randomUUID();
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
let ready: any;
let interrupted = false;
let submitted = false;
let stopSent = false;
let stopCause: string | null = null;
let stoppingAt = 0;
let final: any = null;
let failure: string | null = null;
let shutdownConfirmed = false;
const child = spawn(process.execPath, ['src/server.ts'], {
  env: { ...process.env, LAB_BACKEND: replay ? 'maa-replay' : 'maa-live', LAB_DATA: grant.data,
    LAB_PYTHON: resolve('.venv/Scripts/python.exe'), LAB_APP_TOKEN: token, LAB_ADAPTER_TOKEN: adapterToken,
    MAA_LIVE_GRANT: grantPath, LAB_DEVICE_LOCK: join(grant.data, 'replay-only.lock'),
    LAB_TS_FAULTS: '{}', LAB_PY_FAULTS: replay ? '{"tick_ms":240}' : '{}', LAB_DETACHED: '1',
    LAB_LEASE_MS: '10000', LAB_STOP_DEADLINE_MS: '20000', LAB_POLL_MS: '200', LAB_HTTP_TIMEOUT_MS: '2000' },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
child.stderr!.on('data', data => appendFileSync(join(grant.data, 'stderr.log'), data));
child.on('error', error => { failure = String(error); });
createInterface({ input: child.stdout! }).on('line', line => {
  appendFileSync(join(grant.data, 'timeline.jsonl'), line + '\n');
  try { const value = JSON.parse(line); if (value.kind === 'ready') ready = value; } catch { /* raw Core log */ }
});
process.on('SIGINT', () => { interrupted = true; });
process.on('SIGTERM', () => { interrupted = true; });
async function api(path: string, method = 'GET', body?: object): Promise<any> {
  const response = await fetch(ready.address + path, { method, signal: AbortSignal.timeout(3500),
    headers: { 'content-type': 'application/json', 'x-app-token': token },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  const value = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(value)}`);
  return value;
}
async function requestStop(cause: string) {
  if (stopSent || !submitted) return;
  stopSent = true; stopCause = cause; stoppingAt = Date.now();
  console.log('正在通过 HTTP 请求停止；请等待自动化停止确认。');
  await api(`/tasks/${grant.id}/stop`, 'POST');
}
try {
  const startupDeadline = Date.now() + 15000;
  while (!ready && Date.now() < startupDeadline && !failure) {
    if (child.exitCode !== null) throw new Error(`后端提前退出 ${child.exitCode}`);
    await pause(100);
  }
  if (!ready) throw new Error(failure ?? '后端启动超时');
  if (!interrupted) {
    // 标记发生在发出请求前：网络响应未知也按原 id 查询，不重复提交。
    submitted = true;
    try { await api('/tasks', 'POST', { id: grant.id, params: grant.params }); }
    catch (error) { console.log(`提交响应待核对：${String(error)}；继续按原标识查询。`); }
    const deadline = Date.now() + (replay ? 20000 : 12 * 60 * 1000);
    let lastDisplay = '';
    while (true) {
      if (interrupted || Date.now() > deadline) await requestStop(interrupted ? 'operator' : 'time_limit');
      const task = await api(`/tasks/${grant.id}`);
      const display = `${task.state}：已确认 ${task.confirmed}，开战证据 ${task.started_cycles ?? 0}`;
      if (display !== lastDisplay) { console.log(display); lastDisplay = display; }
      if (!stopSent && task.started_cycles >= 2 && task.confirmed >= 1) await requestStop('second_battle_started');
      if (task.state === 'ended') { final = task; break; }
      if (task.state === 'unknown' || task.state === 'rejected') throw new Error(`执行需核对：${JSON.stringify(task)}`);
      if (stopSent && Date.now() - stoppingAt > 20000) throw new Error('普通停止尚未确认；进入应用退出流程并保留未知');
      await pause(replay ? 60 : 200);
    }
  }
} catch (error) { failure = String(error); console.error(failure); }
finally {
  try {
    if (ready && child.exitCode === null && child.signalCode === null) {
      // 应用退出：TS 按既定策略先停止，超时只终止它自己启动的 Python。
      await api('/shutdown', 'POST');
      const until = Date.now() + 28000;
      while (child.exitCode === null && child.signalCode === null && Date.now() < until) await pause(100);
    }
    shutdownConfirmed = child.exitCode !== null && (!ready || !alive(ready.adapter.pid));
  } catch (error) { failure ??= String(error); }
  const stopScenarioObserved = stopCause === 'second_battle_started' && final?.automation_stopped === true &&
    final.confirmed === 1 && final.unsettled_cycles === 1 && final.certainty === 'lower_bound';
  const result = { mode: replay ? 'offline_callback_replay' : 'live', final, stopCause, stopScenarioObserved,
    shutdownConfirmed, failure, onsite_verification: 'pending' };
  writeFileSync(join(grant.data, 'handoff-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  console.log(`记录目录：${grant.data}`);
  if (!shutdownConfirmed) console.error('进程退出尚未确认，请回到 Codex 核对，勿重复启动。');
  process.exitCode = failure || !stopScenarioObserved || !shutdownConfirmed ? 1 : 0;
}

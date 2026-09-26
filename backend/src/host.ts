import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { pythonRuntime } from './python-runtime.ts';
import { repository, withoutModelCredentials } from './config.ts';
import type { Config } from './config.ts';
import { Store } from './store.ts';
import { TaskService } from './task-service.ts';
import { TaskError } from './task-contract.ts';
import type { TaskView } from './task-contract.ts';
import { BusinessService } from './business/service.ts';
import type { Catalog } from './business/catalog.ts';

const pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
type Ready = { instance: string; controller: string; port: number; pid: number };
type Health = { retiring: boolean; storage_failed: boolean; active: string[] };

export function adapterEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return withoutModelCredentials(environment);
}

export async function startHost(config: Config, options: { business?: boolean; catalog?: Catalog } = {}) {
  mkdirSync(config.dataDir, { recursive: true });
  let controller: string, token: string, child!: ChildProcess, ready!: Ready;
  let exited = true;
  let tasks: TaskService | undefined;
  async function launchExecutor() {
    controller = randomUUID(); token = randomUUID();
    const runtime = pythonRuntime(config.python);
    const childEnv = adapterEnvironment();
    child = spawn(runtime.executable, ['-S', '-u', resolve(repository, 'adapter/maa/main.py')], {
      env: { ...childEnv, PYTHONPATH: runtime.site, CHATMAA_ADAPTER_CONFIG: JSON.stringify({
        mode: config.mode, data: config.dataDir, controller, token, lease_ms: config.leaseMs,
        stop_deadline_ms: config.stopDeadlineMs, installation: config.installation, hwnd: config.hwnd,
        connection: config.connection,
      }) },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: true,
    });
    exited = false;
    child.on('exit', () => { exited = true; tasks?.adapterExited(); });
    child.on('error', () => {
      if (!child.pid) { exited = true; tasks?.adapterExited(); }
    });
    child.stderr!.on('data', chunk => process.stderr.write(chunk));

    try {
      ready = await new Promise<Ready>((ok, fail) => {
        const timer = setTimeout(() => fail(new Error('Adapter 启动超时')), 10000);
        const reject = (error: Error) => { clearTimeout(timer); fail(error); };
        child.once('error', reject);
        child.once('exit', code => reject(new Error(`Adapter 在就绪前退出：${code}`)));
        createInterface({ input: child.stdout! }).on('line', line => {
          let message;
          try { message = JSON.parse(line); } catch { return; }
          if (message.kind === 'ready') {
            if (message.pid !== child.pid || message.controller !== controller) return reject(new Error('Adapter 身份不匹配'));
            clearTimeout(timer); ok(message);
          }
        });
      });
    } catch (error) {
      child.kill();
      const until = Date.now() + 3000;
      while (!exited && Date.now() < until) await pause(20);
      throw error;
    }
  }
  await launchExecutor();
  async function call(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    if (exited) throw new TaskError(503, 'executor_exited');
    const response = await fetch(`http://127.0.0.1:${ready.port}${path}`, {
      method, signal: AbortSignal.timeout(config.httpTimeoutMs),
      headers: { 'content-type': 'application/json', 'x-control-token': token,
        'x-controller-id': controller, 'x-instance-id': ready.instance },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json() as { detail?: string; error?: string };
    if (!response.ok) throw new TaskError(response.status, typeof value.detail === 'string' ? value.detail : value.error ?? 'adapter_rejected');
    return value;
  }
  let store: Store;
  try { store = new Store(resolve(config.dataDir, 'business.sqlite')); }
  catch (error) { await call('/shutdown', 'POST').catch(() => {}); child.kill(); throw error; }
  tasks = new TaskService(store, { instance: ready.instance, call },
    config.mode === 'maa-replay' ? 'offline_callback_replay' : 'MaaCore_v6.17.5');
  const service = tasks;
  const heartbeat = setInterval(() => { if (!service.closing && !service.restarting) void call('/lease', 'POST').catch(() => {}); }, config.pollMs);
  let business: BusinessService | undefined;
  try {
    // Reconcile existing records before exposing operations; never resubmit them.
    await service.poll(true);
    // Initial business projection must see synchronized history, not startup placeholders.
    if (options.business) business = new BusinessService(service, options.catalog);
  } catch (error) {
    clearInterval(heartbeat);
    await call('/shutdown', 'POST').catch(() => {}); child.kill(); store.db.close(); throw error;
  }
  let polling: Promise<void> | undefined;
  const poll = setInterval(() => {
    if (!service.closing && !service.restarting && !exited && !polling) {
      polling = service.poll().catch(() => { service.storageFailed = true; }).finally(() => { polling = undefined; });
    }
  }, config.pollMs);
  function recoveryLog(kind: string, details: Record<string, unknown> = {}) {
    const entry = JSON.stringify({ kind, at: new Date().toISOString(), ...details });
    try { appendFileSync(resolve(config.dataDir, 'recovery.jsonl'), entry + '\n'); } catch { /* stderr remains available */ }
    console.error(entry);
  }
  let restarting: Promise<void> | undefined;
  service.restartExecutor = () => {
    if (restarting) return restarting;
    if (service.closing || service.storageFailed) throw new TaskError(503, 'service_unavailable');
    service.restarting = true;
    recoveryLog('executor_reconnect_requested', { pid: child.pid, instance: service.adapter.instance });
    restarting = (async () => {
      try {
        await polling;
        const until = Date.now() + config.stopDeadlineMs + config.httpTimeoutMs;
        await call('/prepare-shutdown', 'POST').catch(() => {});
        await service.poll(true);
        await call('/shutdown', 'POST').catch(() => {});
        while (!exited && Date.now() < until) { await service.poll(); await pause(50); }
        if (!exited) {
          child.kill();
          const deadline = Date.now() + 3000;
          while (!exited && Date.now() < deadline) await pause(30);
        }
        if (!exited) throw new TaskError(503, 'executor_exit_unconfirmed');
        recoveryLog('executor_exit_confirmed', { pid: child.pid });
        if (service.closing) return;
        // A new controller is created only after our own child has exited.
        await launchExecutor();
        service.adapter.instance = ready.instance;
        service.exited = false;
        await service.poll(true);
        recoveryLog('executor_reconnected', { pid: ready.pid, instance: ready.instance });
      } catch (error) {
        recoveryLog('executor_reconnect_failed', { reason: error instanceof Error ? error.message : String(error) });
        throw error;
      } finally { service.restarting = false; restarting = undefined; }
    })();
    return restarting;
  };
  let closing: Promise<{ handoffComplete: boolean; childExited: boolean; finalTasks: TaskView[] }> | undefined;
  function close() {
    if (closing) return closing;
    service.closing = true;
    business?.beginShutdown();
    clearInterval(heartbeat); clearInterval(poll);
    closing = (async () => {
      await restarting?.catch(() => {});
      const until = Date.now() + config.stopDeadlineMs + config.httpTimeoutMs;
      let handoffComplete = false;
      try {
        await call('/prepare-shutdown', 'POST');
        await polling;
        // Reconcile stable history once at handoff, not on every periodic poll.
        await service.poll(true);
        while (!exited && Date.now() < until) {
          await service.poll();
          const records = service.list().filter(t => t.state !== 'rejected');
          const health = await call('/health') as Health;
          if (!service.storageFailed && !health.storage_failed && !health.active.length && health.retiring &&
              records.every(t => t.sync.available && !t.gap && !t.evidence_conflict && (t.takeover?.released ||
                (t.state === 'ended' && t.automation_stopped && (!t.recheck || t.recheck.automation_stopped))))) {
            handoffComplete = true; break;
          }
          if (service.storageFailed) break;
          await pause(30);
        }
      } catch { /* retain known evidence; failure does not prove stopped */ }
      await call('/shutdown', 'POST').catch(() => {});
      while (!exited && Date.now() < until) await pause(30);
      if (!exited) {
        child.kill();
        const forceUntil = Date.now() + 3000;
        while (!exited && Date.now() < forceUntil) await pause(30);
      }
      // Do not close storage while a pending poll still owns it.
      await polling;
      const finalTasks = service.list();
      await business?.close();
      if (exited) store.db.close();
      return { handoffComplete, childExited: exited, finalTasks };
    })();
    return closing;
  }
  return { tasks: service, business, close, get pid() { return ready.pid; }, mode: config.mode };
}

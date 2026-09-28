import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { Store } from '../src/store.ts';
import { TaskService } from '../src/task-service.ts';
import { RecoveryService } from '../src/recovery.ts';
import { startHost } from '../src/host.ts';
import { repository } from '../src/config.ts';
import type { Snapshot } from '../src/task-contract.ts';

test('已放行未知历史与当前停止任务共存：可检查、响应丢失不重发、原事实不改写', async t => {
  const store = new Store(':memory:'); t.after(() => store.db.close());
  const remote = new Map<string, Snapshot>(); let probes = 0;
  for (const id of ['old', 'current']) {
    store.prepare(id, { stage: '1-7', count: 2, medicine: 0, premium: 0 }, 'fixture');
    store.mark(id, { state: id === 'old' ? 'unknown' : 'ended', automation_stopped: id !== 'old', device: 'needs_check',
      ...(id === 'old' ? { takeover: { id: 'released', released: true, environment: { ready: true, observed_at: 1, basis: 'fixture' } } } : {}) });
    remote.set(id, JSON.parse(store.get(id)!.snapshot));
  }
  const tasks = new TaskService(store, { instance: 'fixture', async call(path, method) {
    if (path === '/device') return { blockers: [{ id: 'current', seq: 0, kind: 'current' }], recoverable: false, recovery: null };
    const snapshot = remote.get(path.split('/')[2]!.split('?')[0]!)!;
    if (method === 'POST') {
      probes++; snapshot.seq++; snapshot.recheck = { id: 'check', state: 'running', automation_stopped: false, ready: false };
      throw new Error('lost response');
    }
    return { instance: 'fixture', snapshot, events: snapshot.seq ? [{ id: snapshot.id, seq: snapshot.seq, kind: 'recheck', source_instance: 'fixture', snapshot }] : [] };
  } }, 'fixture');
  await tasks.poll(true);
  const recovery = new RecoveryService(tasks);
  assert.deepEqual((await recovery.status()).actions, ['check']);
  const before = tasks.get('old');
  await assert.rejects(recovery.act('check', 'check'), /lost response/);
  await assert.rejects(recovery.act('check', 'check'), /lost response/);
  await tasks.poll();
  assert.equal((await recovery.status()).state, 'checking');
  assert.equal(probes, 1);
  assert.deepEqual(tasks.get('old'), before);
});

async function until(read: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await read()) return; await new Promise(r => setTimeout(r, 30)); }
  assert.fail('等待恢复事实超时');
}

test('正式回放：执行中调整→检查→新方案；宿主重连保留会话且不重跑', async t => {
  const config = { mode: 'maa-replay' as const, dataDir: resolve(repository, '.artifacts/checks', `recovery-${Date.now()}`),
    python: resolve(repository, 'adapter/maa/.venv/Scripts/python.exe'), port: 0, pollMs: 50, httpTimeoutMs: 800,
    leaseMs: 5000, stopDeadlineMs: 1500 };
  const host = await startHost(config, { business: true });
  t.after(() => host.close()); const b = host.business!; const recovery = new RecoveryService(host.tasks);
  b.createConversation('chat', '执行中调整'); b.appendMessage('chat', 'goal', 'user', '刷100次');
  b.createRequest('chat', 'request', 'goal', { kind: 'count', quantity: 100, stage: '1-7' });
  const plan = b.conversation('chat').currentPlan!; b.present(plan, 'shown');
  const task = await b.confirm(plan, 'shown', 'confirmed', 'button');
  b.appendMessage('chat', 'adjust', 'user', '改为总共50次');
  await b.adjust(task.id, 'adjusted', 'adjust', { kind: 'count', quantity: 50, stage: '1-7' }, 'total');
  await until(() => host.tasks.get(task.id).state === 'ended');
  assert.equal((await recovery.status()).state, 'needs_check');
  const prior = host.tasks.get(task.id);
  await recovery.act('check', 'check');
  await until(() => host.tasks.get(task.id).recheck?.ready === true);
  await until(() => b.conversation('chat').currentPlan !== null);
  const next = b.plan(b.conversation('chat').currentPlan!);
  assert.equal(next.state, 'unpresented'); assert.equal(next.taskId, null);
  assert.equal(host.tasks.list().length, 1);
  assert.equal(host.tasks.get(task.id).confirmed, prior.confirmed);
  const pid = host.pid;
  await host.tasks.restartExecutor!();
  assert.notEqual(host.pid, pid);
  assert.equal(b.conversation('chat').currentPlan, next.id);
  assert.equal(host.tasks.list().length, 1);
  b.present(next.id, 'next-shown');
  const interrupted = await b.confirm(next.id, 'next-shown', 'next-confirm', 'button');
  process.kill(host.pid); // Fault injection only into this test's own replay executor.
  await until(() => host.tasks.exited);
  assert.deepEqual((await recovery.status()).actions, ['reconnect']);
  await recovery.act('reconnect', 'reconnect');
  assert.equal((await recovery.status()).state, 'needs_check');
  const unknown = host.tasks.get(interrupted.id);
  assert.equal(unknown.state, 'unknown');
  await recovery.act('historical-check', 'check');
  await until(() => host.tasks.get(interrupted.id).takeover?.released === true);
  assert.equal(host.tasks.get(interrupted.id).state, 'unknown');
  assert.equal(host.tasks.get(interrupted.id).confirmed, unknown.confirmed);
  assert.equal(host.tasks.list().length, 2);
  assert.equal((await host.close()).childExited, true);
  const reopened = await startHost(config, { business: true }); t.after(() => reopened.close());
  await until(async () => (await new RecoveryService(reopened.tasks).status()).state === 'ready');
  assert.equal(reopened.tasks.get(interrupted.id).takeover?.released, true);
  assert.equal(reopened.tasks.get(interrupted.id).state, 'unknown');
  assert.equal(reopened.tasks.list().length, 2, '同目录重启不重跑历史');
  reopened.business!.appendMessage('chat', 'fresh-goal', 'user', '再刷一次');
  reopened.business!.createRequest('chat', 'fresh-request', 'fresh-goal', { kind: 'count', quantity: 1, stage: '1-7' });
  assert.equal(reopened.business!.plan(reopened.business!.conversation('chat').currentPlan!).state, 'unpresented');
});

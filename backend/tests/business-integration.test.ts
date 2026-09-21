import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { repository } from '../src/config.ts';
import { startHost } from '../src/host.ts';
import { createApp } from '../src/app.ts';
import type { BusinessService } from '../src/business/service.ts';

async function until<T>(read: () => T, accept: (v: T) => boolean) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { const value = read(); if (accept(value)) return value; await new Promise(r => setTimeout(r, 30)); }
  throw new Error('业务联调没有取得预期事实');
}
test('同目录重启先同步历史，保留仍有效的已展示库存方案和确认防重', async t => {
  const dataDir = resolve(repository, '.artifacts/checks', `business-pending-${Date.now()}`);
  const config = { mode: 'maa-replay' as const, dataDir, python: resolve(repository, 'adapter/maa/.venv/Scripts/python.exe'),
    port: 0, pollMs: 50, httpTimeoutMs: 1000, leaseMs: 5000, stopDeadlineMs: 3000 };
  const host = await startHost(config, { business: true }); t.after(() => host.close());
  const b = host.business!;
  b.createConversation('chat', '待确认库存方案'); b.appendMessage('chat', 'goal', 'user', '补到75');
  b.createRequest('chat', 'request', 'goal', { kind: 'inventory', quantity: 75, itemId: '30012', stage: '1-7' });
  await b.scan('request', 1, 'scan', '先查看库存');
  const planId = await until(() => b.conversation('chat').currentPlan, id => id !== null);
  b.present(planId!, 'shown');
  const audit = () => readFileSync(resolve(dataDir, 'worker-audit.jsonl'), 'utf8').trim().split('\n').length;
  assert.equal(audit(), 1);
  assert.equal((await host.close()).handoffComplete, true);
  const restarted = await startHost(config, { business: true }); t.after(() => restarted.close());
  const restored = restarted.business!;
  assert.equal(restored.conversation('chat').currentPlan, planId);
  assert.equal(restored.plan(planId!).state, 'presented');
  assert.equal(restored.records.read('observations', 'scan')!.reliable, true);
  assert.equal(audit(), 1, '启动核对不能再次扫描或刷图');
  const task = await restored.confirm(planId!, 'shown', 'confirm', 'button');
  assert.equal((await restored.confirm(planId!, 'shown', 'retry', 'button')).id, task.id);
  await until(() => restored.task(task.id), value => value.task.state === 'ended');
  assert.equal(audit(), 2); assert.equal(restored.task(task.id).result!.target, 'achieved');
});

test('MVP 业务 API 经正式 Python HTTP 与双库走通三种目标、停止和同目录恢复；不调用模型或游戏', async t => {
  const dataDir = resolve(repository, '.artifacts/checks', `business-${Date.now()}`);
  const config = { mode: 'maa-replay' as const, dataDir, python: resolve(repository, 'adapter/maa/.venv/Scripts/python.exe'),
    port: 0, pollMs: 50, httpTimeoutMs: 1000, leaseMs: 5000, stopDeadlineMs: 3000 };
  const host = await startHost(config, { business: true });
  const b = host.business!; const app = createApp(host.tasks, 'test', () => {}, undefined, b);
  t.after(async () => { await app.close(); await host.close(); });
  async function operation(body: object) {
    const response = await app.inject({ method: 'POST', url: '/business/operations', headers: { 'x-app-token': 'test' }, payload: body });
    assert.equal(response.statusCode, 200, response.body); return response.json();
  }
  assert.equal((await app.inject({ method: 'POST', url: '/tasks', headers: { 'x-app-token': 'test' },
    payload: { id: 'bypass', params: { version: 2, kind: 'scan_inventory' } } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/business/status' })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/business/status', headers: { 'x-app-token': 'test', origin: 'http://evil.invalid' } })).statusCode, 403);
  await operation({ operation: 'create_conversation', id: 'chat', title: '独立业务联调' });
  async function request(id: string, goal: object) {
    await operation({ operation: 'append_message', conversationId: 'chat', id: `message-${id}`, role: 'user', text: `明确请求 ${id}` });
    return operation({ operation: 'create_request', conversationId: 'chat', id, sourceMessage: `message-${id}`, goal });
  }
  async function start(business: BusinessService = b) {
    const plan = business.plan(business.conversation('chat').currentPlan!);
    await operation({ operation: 'present_plan', planId: plan.id, id: `shown-${plan.id}` });
    return operation({ operation: 'confirm_plan', planId: plan.id, presentationId: `shown-${plan.id}`, id: `start-${plan.id}`, source: 'button' });
  }
  await request('inventory', { kind: 'inventory', quantity: 75, itemId: '30012', stage: '1-7' });
  await operation({ operation: 'scan_inventory', requestId: 'inventory', revision: 1, id: 'scan', explanation: '先查看库存。' });
  await until(() => b.conversation('chat').currentPlan, id => id !== null);
  const inventoryPlan = b.plan(b.conversation('chat').currentPlan!); assert.equal(inventoryPlan.quantity, 3);
  const inventory = await start();
  const inventoryResult = await until(() => b.task(inventory.id), v => v.task.state === 'ended' && !!v.result);
  assert.equal(inventoryResult.result!.target, 'achieved'); assert.equal(inventoryResult.result!.estimatedInventory!.value, 76);
  assert.equal(inventoryResult.task.evidence_source, 'synthetic_d2_callbacks');
  await request('material', { kind: 'material', quantity: 3, itemId: '30012', stage: '1-7' });
  const material = await start();
  await until(() => b.task(material.id), v => v.task.state === 'ended');
  assert.equal(b.task(material.id).result!.amount.value, 4);
  await request('count', { kind: 'count', quantity: 2, stage: '1-7' });
  const count = await start(); await until(() => b.task(count.id), v => v.task.state === 'ended');
  assert.equal(b.task(count.id).result!.amount.value, 2);
  await request('stop', { kind: 'count', quantity: 100, stage: '1-7' });
  const active = await start();
  await until(() => b.task(active.id), v => v.task.started_cycles > 0);
  await operation({ operation: 'stop_task', id: active.id });
  const stopped = await until(() => b.task(active.id), v => v.task.state === 'ended');
  assert.equal(stopped.task.automation_stopped, true); assert.equal(stopped.task.device, 'needs_check');
  const messagesBeforeRestart = b.conversation('chat').messages.length;
  assert.ok(messagesBeforeRestart > 8);
  const audit = () => readFileSync(resolve(dataDir, 'worker-audit.jsonl'), 'utf8').trim().split('\n').length;
  assert.equal(audit(), 5);
  const evidence = new DatabaseSync(resolve(dataDir, 'executor.sqlite'), { readOnly: true });
  try {
    for (const id of ['scan', inventory.id, material.id, count.id, active.id]) {
      assert.equal(host.tasks.store.db.prepare('SELECT COUNT(*) AS n FROM evidence WHERE id=?').get(id)!.n,
        evidence.prepare('SELECT COUNT(*) AS n FROM events WHERE id=?').get(id)!.n);
    }
  } finally { evidence.close(); }
  await app.close(); const closed = await host.close(); assert.equal(closed.childExited, true); assert.equal(closed.handoffComplete, true);
  const restarted = await startHost(config, { business: true }); t.after(() => restarted.close());
  assert.equal(restarted.business!.task(inventory.id).result!.target, 'achieved');
  assert.equal(restarted.business!.conversation('chat').requests.length, 4);
  assert.ok(restarted.business!.conversation('chat').messages.length >= messagesBeforeRestart);
  assert.notEqual(restarted.business!.global().admission.state, 'ready');
  restarted.business!.conversation('chat'); await restarted.tasks.poll();
  assert.equal(audit(), 5, '恢复和历史读取不能重跑');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { repository } from '../src/config.ts';
import { startHost } from '../src/host.ts';
import { createApp } from '../src/app.ts';
import { RuntimeService } from '../src/runtime/service.ts';
import { modelRunner } from '../src/runtime/loop.ts';

const response = (content: LanguageModelV4GenerateResult['content']): LanguageModelV4GenerateResult => ({ content,
  finishReason: { unified: content.some(c => c.type === 'tool-call') ? 'tool-calls' : 'stop', raw: undefined },
  usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] });

test('Runtime HTTP、实际 Backend 与正式 Python 回放：展示后消息确认、结果入会话和退出', async t => {
  const host = await startHost({ mode: 'maa-replay', dataDir: resolve(repository, '.artifacts/checks', `runtime-${Date.now()}`),
    python: resolve(repository, 'adapter/maa/.venv/Scripts/python.exe'), port: 0, pollMs: 50,
    httpTimeoutMs: 1000, leaseMs: 5000, stopDeadlineMs: 3000 }, { business: true });
  const business = host.business!; let sampled = 0;
  const model = new MockLanguageModelV4({ doGenerate: async options => {
    sampled++;
    if (sampled === 1) return response([{ type: 'tool-call', toolCallId: 'create', toolName: 'create_request',
      input: JSON.stringify({ goal: { kind: 'count', quantity: 1, stage: '1-7' } }) }]);
    if (sampled === 3) return response([{ type: 'tool-call', toolCallId: 'confirm', toolName: 'confirm_plan',
      input: JSON.stringify({ planId: business.conversation('chat').currentPlan, presentationId: 'shown' }) }]);
    if (sampled === 4) assert.equal(options.toolChoice?.type, 'none');
    return response([{ type: 'text', text: sampled === 2 ? '请查看方案后确认。' : '已受理，请查看任务事实。' }]);
  } });
  const runtime = new RuntimeService(business, modelRunner(business, model)); runtime.enableFollowups();
  const app = createApp(host.tasks, 'runtime-test', () => {}, undefined, business, runtime);
  t.after(async () => { await runtime.close(); await app.close(); await host.close(); });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  async function request(path: string, body?: unknown, origin?: string) {
    const result = await fetch(`${address}${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-app-token': 'runtime-test', ...(origin ? { origin } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: result.status, value: await result.json() };
  }
  assert.equal((await request('/runtime/status', undefined, 'http://other.invalid')).status, 403);
  assert.equal((await request('/runtime/messages', { conversationId: 'chat', messageId: 'bad', text: '查询', source: 'button' })).status, 422);
  await request('/business/operations', { operation: 'create_conversation', id: 'chat', title: 'Runtime 正式回放' });
  const accepted = await request('/runtime/messages', { conversationId: 'chat', messageId: 'goal', text: '刷1-7一次' });
  assert.equal(accepted.status, 202); await runtime.settled(accepted.value.id);
  assert.equal(host.tasks.store.all().length, 0);
  const conversation = (await request('/runtime/conversations/chat')).value;
  const planId = conversation.business.currentPlan;
  assert.ok(planId);
  // Explicit simulated display receipt; this does not claim a Web UI exists.
  await request('/business/operations', { operation: 'present_plan', planId, id: 'shown' });
  const confirmed = await request('/runtime/messages', { conversationId: 'chat', messageId: 'confirm-message', text: '按这个开始' });
  await runtime.settled(confirmed.value.id);
  assert.equal(runtime.read(confirmed.value.id).turn.state, 'completed');
  const taskId = business.plan(planId).taskId!; assert.ok(taskId);
  const deadline = Date.now() + 10000;
  while (business.task(taskId).task.state !== 'ended' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(business.task(taskId).result?.target, 'achieved');
  assert.equal(host.tasks.store.all().length, 1);
  const duplicate = await request('/runtime/messages', { conversationId: 'chat', messageId: 'confirm-message', text: '按这个开始' });
  assert.equal(duplicate.value.id, confirmed.value.id); assert.equal(sampled, 4);
  assert.ok(business.conversation('chat').messages.some(m => m.reference === taskId && m.id.startsWith('result-')));
  await runtime.close(); await app.close();
  const closed = await host.close(); assert.equal(closed.childExited, true); assert.equal(closed.handoffComplete, true);
});

for (const kind of ['material', 'inventory'] as const) test(`Runtime 正式回放：${kind} 目标经工具准备、扫描条件与独立结果`, async t => {
  const host = await startHost({ mode: 'maa-replay', dataDir: resolve(repository, '.artifacts/checks', `runtime-${kind}-${Date.now()}`),
    python: resolve(repository, 'adapter/maa/.venv/Scripts/python.exe'), port: 0, pollMs: 50,
    httpTimeoutMs: 1000, leaseMs: 5000, stopDeadlineMs: 3000 }, { business: true });
  const business = host.business!; business.createConversation('chat', kind); let phase = 0;
  const tool = (name: string, input: unknown) => response([{ type: 'tool-call', toolCallId: `${name}-${phase}`, toolName: name, input: JSON.stringify(input) }]);
  const model = new MockLanguageModelV4({ doGenerate: async options => {
    const step = phase++;
    if (step === 0) return tool('create_request', { goal: { kind, quantity: kind === 'inventory' ? 75 : 3, itemId: '30012', stage: '1-7' } });
    if (step === 1 && kind === 'inventory') {
      const request = business.request(business.conversation('chat').currentRequest!);
      assert.ok(request.waiting.includes('inventory_required'));
      return tool('scan_inventory', { requestId: request.id, revision: request.revision, explanation: '先扫描固源岩库存，再准备差额方案。' });
    }
    if (step === 10) return tool('confirm_plan', { planId: business.conversation('chat').currentPlan, presentationId: 'display' });
    if (step === 11 || (kind === 'inventory' && step === 2)) assert.equal(options.toolChoice?.type, 'none');
    return response([{ type: 'text', text: step < 10 ? '依据当前事实，等待方案展示与确认。' : '已受理，结果请看任务事实。' }]);
  } });
  const runtime = new RuntimeService(business, modelRunner(business, model)); runtime.enableFollowups();
  t.after(async () => { await runtime.close(); await host.close(); });
  const first = runtime.submit('chat', 'goal', kind === 'inventory' ? '固源岩补到75个' : '再获得3个固源岩');
  await runtime.settled(first.id);
  assert.equal(runtime.read(first.id).turn.state, 'completed');
  const deadline = Date.now() + 10000;
  while (!business.conversation('chat').currentPlan && Date.now() < deadline) await new Promise(r => setTimeout(r, 30));
  const plan = business.plan(business.conversation('chat').currentPlan!);
  assert.equal(plan.quantity, 3);
  assert.equal(host.tasks.store.all().length, kind === 'inventory' ? 1 : 0);
  business.present(plan.id, 'display'); phase = 10;
  const confirmation = runtime.submit('chat', 'confirmation', '按方案开始'); await runtime.settled(confirmation.id);
  assert.equal(runtime.read(confirmation.id).turn.state, 'completed');
  const taskId = business.plan(plan.id).taskId!; assert.ok(taskId);
  const until = Date.now() + 10000;
  while (business.task(taskId).task.state !== 'ended' && Date.now() < until) await new Promise(r => setTimeout(r, 30));
  const final = business.task(taskId);
  assert.equal(final.result?.target, 'achieved');
  assert.equal(final.task.material_result?.certainty, 'exact');
  if (kind === 'inventory') assert.equal(final.result?.initialInventory, 72);
  assert.equal(host.tasks.store.all().length, kind === 'inventory' ? 2 : 1);
  assert.ok(business.conversation('chat').messages.some(m => m.id === `result-${taskId}` || (m.reference === taskId && m.id.startsWith('result-'))));
});

test('正式扫描缺失所需材料时触发真实 D3 后续事件，后台只读澄清而不猜零', async t => {
  const host = await startHost({ mode: 'maa-replay', dataDir: resolve(repository, '.artifacts/checks', `runtime-missing-${Date.now()}`),
    python: resolve(repository, 'adapter/maa/.venv/Scripts/python.exe'), port: 0, pollMs: 50,
    httpTimeoutMs: 1000, leaseMs: 5000, stopDeadlineMs: 3000 }, { business: true });
  const business = host.business!; business.createConversation('chat', '缺失库存');
  business.appendMessage('chat', 'goal', 'user', '补到75个固源岩组');
  business.createRequest('chat', 'request', 'goal', { kind: 'inventory', quantity: 75, itemId: '30013' });
  let sampled = 0;
  const model = new MockLanguageModelV4({ doGenerate: async options => {
    sampled++; assert.ok(!options.tools?.some(tool => tool.name === 'scan_inventory'));
    assert.match(JSON.stringify(options.prompt), /scan_needs_input/);
    return response([{ type: 'text', text: '扫描未识别所需材料，库存未知，不能按零计算。请确认下一步。' }]);
  } });
  const runtime = new RuntimeService(business, modelRunner(business, model)); runtime.enableFollowups();
  t.after(async () => { await runtime.close(); await host.close(); });
  await business.scan('request', 1, 'scan', '先扫描库存');
  const deadline = Date.now() + 10000;
  while (!business.conversation('chat').messages.some(m => m.role === 'assistant') && Date.now() < deadline) await new Promise(r => setTimeout(r, 30));
  assert.equal(sampled, 1);
  assert.equal(business.conversation('chat').currentPlan, null);
  assert.ok(business.request('request').waiting.includes('inventory_required'));
  assert.equal(business.records.list('continuations')[0].state, 'completed');
  assert.equal(host.tasks.store.all().length, 1);
});

test('执行中模型选到不可比较的调整目标仍先停止，拒绝不恢复旧任务或创建替代执行', async t => {
  const host = await startHost({ mode: 'maa-replay', dataDir: resolve(repository, '.artifacts/checks', `runtime-adjust-${Date.now()}`),
    python: resolve(repository, 'adapter/maa/.venv/Scripts/python.exe'), port: 0, pollMs: 50,
    httpTimeoutMs: 1000, leaseMs: 5000, stopDeadlineMs: 3000 }, { business: true });
  const business = host.business!; business.createConversation('chat', '执行中调整');
  business.appendMessage('chat', 'goal', 'user', '刷100次');
  business.createRequest('chat', 'request', 'goal', { kind: 'count', quantity: 100, stage: '1-7' });
  const planId = business.conversation('chat').currentPlan!; business.present(planId, 'display');
  const started = await business.confirm(planId, 'display', 'confirmation', 'button');
  let sampled = 0;
  const model = new MockLanguageModelV4({ doGenerate: async options => {
    sampled++;
    if (sampled === 1) return response([{ type: 'tool-call', toolCallId: 'adjust', toolName: 'adjust_task', input: JSON.stringify({
      taskId: started.id, goal: { kind: 'material', itemId: '30012', quantity: 5 }, semantics: 'total' }) }]);
    assert.match(JSON.stringify(options.prompt), /incomparable_total_goal/);
    return response([{ type: 'text', text: '已经请求停止；次数与材料总目标不可直接比较，请明确新目标。' }]);
  } });
  const runtime = new RuntimeService(business, modelRunner(business, model));
  t.after(async () => { await runtime.close(); await host.close(); });
  const turn = runtime.submit('chat', 'adjust-message', '改成总共获得5个固源岩'); await runtime.settled(turn.id);
  assert.equal(runtime.read(turn.id).turn.state, 'completed');
  assert.equal(host.tasks.get(started.id).stop_requested, true);
  const deadline = Date.now() + 10000;
  while (!host.tasks.get(started.id).automation_stopped && Date.now() < deadline) await new Promise(r => setTimeout(r, 30));
  assert.equal(host.tasks.get(started.id).automation_stopped, true);
  assert.equal(host.tasks.store.all().length, 1);
  assert.equal(business.conversation('chat').requests.length, 1);
});

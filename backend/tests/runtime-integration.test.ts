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
  const model = new MockLanguageModelV4({ doGenerate: async () => {
    sampled++;
    if (sampled === 1) return response([{ type: 'tool-call', toolCallId: 'create', toolName: 'create_request',
      input: JSON.stringify({ goal: { kind: 'count', quantity: 1, stage: '1-7' } }) }]);
    if (sampled === 3) return response([{ type: 'tool-call', toolCallId: 'confirm', toolName: 'confirm_plan',
      input: JSON.stringify({ planId: business.conversation('chat').currentPlan, presentationId: 'shown' }) }]);
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

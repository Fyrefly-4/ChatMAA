// Formal Web/Runtime/Backend/Python replay. Only model responses are scripted.
// These phrases define test scenarios; they are not production intent parsing.
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { repository } from '../src/config.ts';
import { startHost } from '../src/host.ts';
import { createApp } from '../src/app.ts';
import { RuntimeService } from '../src/runtime/service.ts';
import { modelRunner } from '../src/runtime/loop.ts';
import type { contextFor } from '../src/runtime/context.ts';

const dataDir = resolve(repository, '.artifacts/checks', `mvp-web-${randomUUID()}`);
mkdirSync(dataDir, { recursive: true });
const host = await startHost({ mode: 'maa-replay', dataDir, port: 0, pollMs: 40, httpTimeoutMs: 1000,
  leaseMs: 5000, stopDeadlineMs: 3000, python: resolve(repository, 'adapter/maa/.venv/Scripts/python.exe') }, { business: true });
const b = host.business!;
const response = (content: LanguageModelV4GenerateResult['content']): LanguageModelV4GenerateResult => ({ content,
  finishReason: { unified: content.some(c => c.type === 'tool-call') ? 'tool-calls' : 'stop', raw: undefined },
  usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] });
const counts = new Map<string, number>();
const model = new MockLanguageModelV4({ doGenerate: async options => {
  const message = options.prompt.find(m => m.role === 'user');
  const part = message?.role === 'user' ? message.content.find(c => c.type === 'text') : undefined;
  if (!part || part.type !== 'text') throw new Error('fixture missing context');
  const ctx = JSON.parse(part.text) as ReturnType<typeof contextFor>;
  const source = ctx.anchors.find(a => a.id === ctx.pendingSources.at(-1)) ?? ctx.anchors.at(-1)!;
  const step = counts.get(source.id) ?? 0; counts.set(source.id, step + 1);
  const tool = (toolName: string, input: unknown) => response([{ type: 'tool-call', toolCallId: randomUUID(), toolName, input: JSON.stringify(input) }]);
  if (source.text === '模型故障') throw new Error('controlled model failure');
  if (options.toolChoice?.type === 'none') return response([{ type: 'text', text: '操作已受理，请查看独立任务事实。' }]);
  if (step === 0) {
    if (source.text === '刷1-7两次' || source.text === '刷1-7一百次') return tool('create_request', { goal: { kind: 'count', stage: '1-7', quantity: source.text.includes('百') ? 100 : 2 } });
    if (source.text === '再获得3个固源岩') return tool('create_request', { goal: { kind: 'material', itemId: '30012', stage: '1-7', quantity: 3 } });
    if (source.text === '固源岩补到75个' || source.text === '固源岩补到1个') return tool('create_request', { goal: { kind: 'inventory', itemId: '30012', stage: '1-7', quantity: source.text === '固源岩补到1个' ? 1 : 75 } });
    if (source.text === '按这个开始') return tool('confirm_plan', { planId: ctx.facts.plan?.id, presentationId: ctx.facts.presentation?.id });
    if (source.text === '改成五次') return tool('revise_request', { requestId: ctx.facts.request?.id, revision: ctx.facts.request?.revision, goal: { kind: 'count', stage: '1-7', quantity: 5 } });
    if (source.text === '停止') return tool('stop_task', { taskId: ctx.facts.plan?.taskId });
    if (source.text === '总共改成五次') return tool('adjust_task', { taskId: ctx.facts.plan?.taskId, goal: { kind: 'count', stage: '1-7', quantity: 5 }, semantics: 'total' });
    if (source.text === '再刷五次') return tool('adjust_task', { taskId: ctx.facts.plan?.taskId, goal: { kind: 'count', stage: '1-7', quantity: 5 }, semantics: 'additional' });
  }
  if (step === 1 && source.text.startsWith('固源岩补到')) {
    const request = b.request(b.records.read('conversations', ctx.facts.conversation.id)!.currentRequest!);
    return tool('scan_inventory', { requestId: request.id, revision: request.revision, explanation: '先扫描库存，再计算缺口。' });
  }
  return response([{ type: 'text', text: step ? '请阅读当前方案，再确认开始。' : '可以继续咨询；游戏任务按独立事实更新。' }]);
} });
const runtime = new RuntimeService(b, modelRunner(b, model)); runtime.enableFollowups();
if (process.env.TEST_MODEL_MODE === 'long-history') {
  b.createConversation('history', '长会话检查');
  for (let i = 0; i < 65; i++) b.appendMessage('history', `history-${i}`, 'user', `历史消息 ${i}`);
  const accepted = runtime.records.accept(b, 'history', 'activity-source', '活动分页检查');
  for (let i = 0; i < 125; i++) runtime.records.activity(accepted.turn.id, 'model_step', { fixture: true, index: i });
  runtime.records.finish(accepted.turn.id, 'completed');
}
const token = randomUUID(); let address = '';
const app = createApp(host.tasks, randomUUID(), () => {}, { token, origin: () => address, staticRoot: resolve(repository, 'web/dist') }, b, runtime);
address = await app.listen({ host: '127.0.0.1', port: 0 });
process.send?.({ kind: 'ready', address, token, dataDir, childPid: host.pid });
let closing = false;
async function close() {
  if (closing) return; closing = true;
  const runtimeClosing = runtime.close(); const businessClosing = b.beginShutdown();
  await runtimeClosing; await businessClosing; await app.close(); const result = await host.close();
  process.send?.({ kind: 'closed', ...result }); process.disconnect();
  process.exitCode = result.childExited && result.handoffComplete ? 0 : 1;
}
process.on('message', message => { if (message === 'close') void close(); });
process.on('disconnect', () => { void close(); });

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { Store } from '../src/store.ts';
import { TaskService } from '../src/task-service.ts';
import { BusinessService } from '../src/business/service.ts';
import { RuntimeService } from '../src/runtime/service.ts';
import { modelRunner } from '../src/runtime/loop.ts';

const response = (content: LanguageModelV4GenerateResult['content']): LanguageModelV4GenerateResult => ({
  content, finishReason: { unified: content.some(c => c.type === 'tool-call') ? 'tool-calls' : 'stop', raw: undefined },
  usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [],
});
const call = (name: string, input: unknown, id = 'call') => response([{ type: 'tool-call', toolCallId: id, toolName: name, input: JSON.stringify(input) }]);
const reply = (text: string) => response([{ type: 'text', text }]);
function setup(model: MockLanguageModelV4, readOnly = false) {
  const store = new Store(':memory:'); let submissions = 0;
  const tasks = new TaskService(store, { instance: 'fixture', call: async () => { submissions++; throw new Error('no_execution_expected'); } }, 'fixture');
  const business = new BusinessService(tasks); business.createConversation('chat', '测试');
  const runtime = new RuntimeService(business, modelRunner(business, model, readOnly));
  return { store, business, runtime, submissions: () => submissions,
    close: async () => { await runtime.close(); await business.close(); store.db.close(); } };
}

test('实际资料工具反馈决定下一步：有材料才建草案，无匹配则澄清', async t => {
  for (const query of ['固源岩', '不存在的材料']) {
    let sampled = 0;
    const model = new MockLanguageModelV4({ doGenerate: async options => {
      sampled++;
      if (sampled === 1) return call('find_material', { query });
      const toolMessages = options.prompt.filter(m => m.role === 'tool');
      const serialized = JSON.stringify(toolMessages);
      if (sampled === 2) {
        assert.ok(toolMessages.length);
        if (serialized.includes('30012')) return call('create_request', { goal: { kind: 'material', itemId: '30012', quantity: 5 } }, 'create');
        return reply('资料未找到，请明确材料名称。');
      }
      assert.match(serialized, /completed/); return reply('方案已准备，请先查看后确认。');
    } });
    const x = setup(model); t.after(x.close);
    const turn = x.runtime.submit('chat', `message-${sampled}`, `再获得五个${query}`);
    const result = await x.runtime.settled(turn.id);
    assert.equal(result.turn.state, 'completed'); assert.equal(x.submissions(), 0);
    const conversation = x.business.conversation('chat');
    assert.equal(conversation.requests.length, query === '固源岩' ? 1 : 0);
    if (conversation.currentPlan) assert.equal(x.business.plan(conversation.currentPlan).state, 'unpresented');
  }
});

test('同一步并行变更被拒绝，不连续替换已创建的请求', async t => {
  const model = new MockLanguageModelV4({ doGenerate: [response([
    { type: 'tool-call', toolCallId: 'a', toolName: 'create_request', input: JSON.stringify({ goal: { kind: 'count', quantity: 5, stage: '1-7' } }) },
    { type: 'tool-call', toolCallId: 'b', toolName: 'create_request', input: JSON.stringify({ goal: { kind: 'count', quantity: 3, stage: '1-7' } }) },
  ]), reply('请确认方案。')] });
  const x = setup(model); t.after(x.close);
  const turn = x.runtime.submit('chat', 'message', '刷1-7五次');
  await x.runtime.settled(turn.id);
  assert.equal(x.business.conversation('chat').requests.length, 1);
  assert.match(JSON.stringify(x.runtime.read(turn.id).activities), /read_updated_facts_in_next_step/);
  assert.equal(x.submissions(), 0);
});

test('修改后同来源消息不能确认新方案，模型工具没有展示权限', async t => {
  let sampled = 0;
  let x: ReturnType<typeof setup>;
  const model = new MockLanguageModelV4({ doGenerate: async () => {
    sampled++;
    if (sampled === 1) return call('create_request', { goal: { kind: 'count', quantity: 5, stage: '1-7' } });
    if (sampled === 2) {
      const planId = x.business.conversation('chat').currentPlan!;
      x.business.present(planId, 'client-display');
      return call('confirm_plan', { planId, presentationId: 'client-display' }, 'confirm');
    }
    return reply('方案需在展示后取得新的确认。');
  } });
  x = setup(model); t.after(x.close);
  const turn = x.runtime.submit('chat', 'message', '改成五次直接开始');
  await x.runtime.settled(turn.id);
  assert.match(JSON.stringify(x.runtime.read(turn.id).activities), /confirmation_message_before_presentation/);
  assert.equal(x.submissions(), 0); assert.equal(x.store.all().length, 0);
});

test('后台只读工具集和循环上限由宿主控制', async t => {
  let steps = 0;
  const model = new MockLanguageModelV4({ doGenerate: async options => {
    steps++;
    assert.ok(!options.tools?.some(tool => tool.name === 'confirm_plan'));
    if (options.toolChoice?.type === 'none') return reply('已达到本轮边界，请查看当前事实。');
    return call('read_state', {}, `read-${steps}`);
  } });
  const x = setup(model, true); t.after(x.close);
  const turn = x.runtime.submit('chat', 'message', '查询状态');
  await x.runtime.settled(turn.id);
  assert.equal(steps, 8); assert.equal(x.submissions(), 0);
});

test('跨会话方案不可修改；额外 source 字段不能冒充按钮确认', async t => {
  const model = new MockLanguageModelV4({ doGenerate: [
    call('revise_request', { requestId: 'other-request', revision: 1, goal: { kind: 'count', quantity: 3, stage: '1-7' } }),
    call('confirm_plan', { planId: 'invented', presentationId: 'invented', source: 'button' }), reply('不能修改或确认该对象。'),
  ] });
  const x = setup(model); t.after(x.close);
  x.business.createConversation('other', '另一个会话');
  x.business.appendMessage('other', 'other-message', 'user', '刷1-7五次');
  x.business.createRequest('other', 'other-request', 'other-message', { kind: 'count', quantity: 5, stage: '1-7' });
  const turn = x.runtime.submit('chat', 'message', '修改那个方案');
  await x.runtime.settled(turn.id);
  assert.equal(x.business.request('other-request').revision, 1);
  assert.match(JSON.stringify(x.runtime.read(turn.id).activities), /object_outside_conversation/);
  assert.equal(x.submissions(), 0);
});

test('被中断轮已创建的请求随原消息承接，不因新工具 call ID 重建', async t => {
  let steps = 0; let waiting!: () => void; let release!: (value: LanguageModelV4GenerateResult) => void;
  const entered = new Promise<void>(resolve => { waiting = resolve; });
  const model = new MockLanguageModelV4({ doGenerate: async options => {
    steps++;
    if (steps === 1) return call('create_request', { goal: { kind: 'count', quantity: 5, stage: '1-7' } }, 'old');
    if (steps === 2) { waiting(); return new Promise(resolve => { release = resolve; }); }
    if (steps === 3) {
      assert.match(JSON.stringify(options.prompt), /pendingSources/);
      assert.match(JSON.stringify(options.prompt), /operations/);
      return call('create_request', { goal: { stage: '1-7', quantity: 5, kind: 'count' }, intentMessageId: 'original' }, 'new-call');
    }
    return reply('沿用已建立的方案，等待确认。');
  } });
  const x = setup(model); t.after(x.close);
  const old = x.runtime.submit('chat', 'original', '刷1-7五次'); await entered;
  const next = x.runtime.submit('chat', 'followup', '刚才处理到哪里了？');
  await x.runtime.settled(next.id);
  assert.equal(x.runtime.read(next.id).turn.state, 'completed');
  assert.equal(x.runtime.read(old.id).turn.state, 'interrupted');
  assert.equal(x.business.conversation('chat').requests.length, 1);
  release(reply('迟到')); await new Promise(resolve => setImmediate(resolve));
});

test('工具活动存储故障后关闭本轮，不能接着产生业务变更', async t => {
  let steps = 0;
  const model = new MockLanguageModelV4({ doGenerate: async () => {
    steps++; return call('create_request', { goal: { kind: 'count', quantity: 5, stage: '1-7' } });
  } });
  const x = setup(model); t.after(x.close);
  x.store.db.exec("CREATE TRIGGER fail_tool_log BEFORE INSERT ON runtime_activities WHEN NEW.kind='tool_call' BEGIN SELECT RAISE(ABORT,'storage_failed'); END");
  const turn = x.runtime.submit('chat', 'message', '刷1-7五次');
  const result = await x.runtime.settled(turn.id);
  assert.equal(result.turn.state, 'failed');
  assert.equal(steps, 1); assert.equal(x.business.conversation('chat').requests.length, 0);
});

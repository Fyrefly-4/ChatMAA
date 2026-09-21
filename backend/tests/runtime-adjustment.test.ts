import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { Store } from '../src/store.ts';
import { TaskService } from '../src/task-service.ts';
import { BusinessService } from '../src/business/service.ts';
import { RuntimeService } from '../src/runtime/service.ts';
import { RuntimeOperations } from '../src/runtime/operations.ts';
import { modelRunner } from '../src/runtime/loop.ts';

for (const incomparable of [false, true]) for (const failAssociation of [false, true]) {
  test(`Runtime 调整${incomparable ? '不可比较目标' : '有效目标'}：${failAssociation ? '关联失败不发送停止' : '仅发送一次已关联停止'}`, async t => {
    const store = new Store(':memory:'); let stops = 0;
    const operations = new RuntimeOperations(store);
    const tasks = new TaskService(store, { instance: 'fixture', call: async (path, method) => {
      if (path === '/executions' && method === 'POST') return {};
      if (path.endsWith('/stop')) { stops++; return {}; }
      const id = path.split('/')[2]?.split('?')[0];
      const snapshot = { ...store.view(id)!, seq: 1, state: 'accepted', device: 'busy' };
      return { instance: 'fixture', snapshot, events: [{ id, seq: 1, kind: 'fixture', source_instance: 'fixture', snapshot }] };
    } }, 'fixture');
    const business = new BusinessService(tasks);
    business.createConversation('chat', '调整工具');
    business.appendMessage('chat', 'goal', 'user', '刷1-7五次');
    business.createRequest('chat', 'request', 'goal', { kind: 'count', quantity: 5, stage: '1-7' });
    const plan = business.plan(business.conversation('chat').currentPlan!); business.present(plan.id, 'display');
    const started = await business.confirm(plan.id, 'display', 'confirmation', 'button');
    const goal = incomparable ? { kind: 'material', itemId: '30012', quantity: 3 } : { kind: 'count', quantity: 3, stage: '1-7' };
    const parameters = { taskId: started.id, goal, semantics: 'total' };
    let steps = 0;
    const model = new MockLanguageModelV4({ doGenerate: async options => {
      steps++;
      const content: LanguageModelV4GenerateResult['content'] = steps === 1 ? [
        { type: 'tool-call', toolCallId: 'adjust', toolName: 'adjust_task', input: JSON.stringify(parameters) },
      ] : [{ type: 'text', text: '停止请求已提交，待执行端确认。' }];
      if (steps === 2) {
        assert.equal(options.toolChoice?.type, 'none');
        if (incomparable) assert.match(JSON.stringify(options.prompt), /incomparable_total_goal/);
      }
      return { content, finishReason: { unified: steps === 1 ? 'tool-calls' : 'stop', raw: undefined },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] };
    } });
    const runtime = new RuntimeService(business, modelRunner(business, model));
    t.after(async () => { await runtime.close(); await business.close(); store.db.close(); });
    if (failAssociation) store.db.exec("CREATE TRIGGER fail_association BEFORE INSERT ON runtime_operations BEGIN SELECT RAISE(ABORT,'association_failed'); END");
    const turn = runtime.submit('chat', 'change', incomparable ? '改成总共获得三个固源岩' : '改成总共三次');
    const result = await runtime.settled(turn.id);
    assert.equal(result.turn.state, failAssociation ? 'failed' : 'completed');
    assert.equal(stops, failAssociation ? 0 : 1);
    assert.equal(store.view(started.id)?.stop_requested, failAssociation ? undefined : true);
    assert.equal(business.conversation('chat').requests.length, failAssociation || incomparable ? 1 : 2);
    const saved = operations.forSources('chat', ['change']);
    assert.equal(saved.length, failAssociation ? 0 : 1);
    if (!failAssociation) {
      assert.equal(saved[0].state, 'completed');
      assert.equal(saved[0].targetId, incomparable ? started.id : business.conversation('chat').currentRequest);
      if (incomparable) assert.match(JSON.stringify(saved[0].result), /incomparable_total_goal/);
      // Re-entry after an interrupted response must read the original operation, not stop again.
      await operations.begin('chat', 'change', 'adjust_task', parameters, () => {}).async(async () => assert.fail('must_not_dispatch_again'));
      assert.equal(stops, 1);
    }
  });
}

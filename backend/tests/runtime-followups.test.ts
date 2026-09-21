import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.ts';
import { TaskService } from '../src/task-service.ts';
import { BusinessService } from '../src/business/service.ts';
import { RuntimeService } from '../src/runtime/service.ts';
import type { RunTurn } from '../src/runtime/service.ts';

async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('condition_timeout');
}
function setup(run: RunTurn) {
  const store = new Store(':memory:');
  const tasks = new TaskService(store, { instance: 'fixture', call: async () => { throw new Error('no_execution_expected'); } }, 'fixture');
  const business = new BusinessService(tasks); business.createConversation('chat', '测试');
  business.appendMessage('chat', 'source', 'user', '补到100个固源岩');
  business.createRequest('chat', 'request', 'source', { kind: 'inventory', quantity: 100, itemId: '30012' });
  // Inject the D3 event boundary; actual Adapter delivery is covered separately.
  business.records.insert('continuations', { id: 'event', conversationId: 'chat', requestId: 'request', revision: 1,
    taskId: null, state: 'pending', reason: 'scan_needs_input', token: null });
  const runtime = new RuntimeService(business, run);
  return { store, business, runtime, event: () => business.records.read('continuations', 'event')!,
    close: async () => { await runtime.close(); await business.close(); store.db.close(); } };
}

test('后台解释以一次性接纳事务发布，token 不进入模型上下文', async t => {
  const x = setup(async input => {
    assert.equal(input.turn.continuationId, 'event');
    assert.equal(JSON.stringify(input.context).includes('"token"'), false);
    assert.match(JSON.stringify(input.context), /scan_needs_input/);
    return '库存识别不完整，请补充处理方式。';
  }); t.after(x.close);
  x.runtime.enableFollowups(); await until(() => x.event().state === 'completed');
  assert.equal(x.event().token, null);
  assert.equal(x.business.conversation('chat').messages.filter(m => m.role === 'assistant').length, 1);
  assert.throws(() => x.business.acceptFollowup('event', 'old-token', () => {}), /followup_not_current/);
});

test('新消息中断后台解释，忽略取消的迟到回复不能发布', async t => {
  let entered!: () => void; let release!: (text: string) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const x = setup(async input => {
    if (input.turn.continuationId) { entered(); return new Promise(resolve => { release = resolve; }); }
    return '已收到新的说明。';
  }); t.after(x.close);
  x.runtime.enableFollowups(); await started;
  const turn = x.runtime.submit('chat', 'new-message', '先不扫描');
  await x.runtime.settled(turn.id);
  assert.equal(x.event().state, 'interrupted'); assert.equal(x.event().token, null);
  release('过期指引'); await new Promise(resolve => setImmediate(resolve));
  const replies = x.business.conversation('chat').messages.filter(m => m.role === 'assistant');
  assert.deepEqual(replies.map(m => m.text), ['已收到新的说明。']);
});

test('后台发布完成记录失败时助手消息和一次性接纳一起回滚', async t => {
  const x = setup(async () => '不应发布的回复'); t.after(x.close);
  x.store.db.exec("CREATE TRIGGER fail_completion BEFORE INSERT ON runtime_activities WHEN NEW.kind='completed' BEGIN SELECT RAISE(ABORT,'completion_failed'); END");
  x.runtime.enableFollowups(); await until(() => x.event().state === 'failed');
  assert.equal(x.business.conversation('chat').messages.filter(m => m.role === 'assistant').length, 0);
  assert.equal(x.event().token, null);
});

test('后台等待活动用户轮；新消息可中断等待，未完成来源不被后台清除', async t => {
  let release!: (text: string) => void;
  let calls = 0;
  const x = setup(async input => {
    calls++;
    if (input.turn.sourceMessage === 'm1') return new Promise(resolve => { release = resolve; });
    return '新轮回答';
  }); t.after(x.close);
  const old = x.runtime.submit('chat', 'm1', '补充说明');
  await new Promise(resolve => setImmediate(resolve));
  x.runtime.enableFollowups(); await until(() => x.event().state === 'processing');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  const next = x.runtime.submit('chat', 'm2', '更正说明'); await x.runtime.settled(next.id);
  assert.equal(x.runtime.read(old.id).turn.state, 'interrupted');
  assert.ok(next.sourceMessages?.includes('m1'));
  assert.equal(x.event().state, 'interrupted');
  release('旧回答'); await new Promise(resolve => setImmediate(resolve));
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.ts';
import { TaskService } from '../src/task-service.ts';
import { BusinessService } from '../src/business/service.ts';
import { RuntimeRecords } from '../src/runtime/records.ts';
import { contextFor } from '../src/runtime/context.ts';
import { RuntimeService } from '../src/runtime/service.ts';

function setup() {
  const store = new Store(':memory:');
  const tasks = new TaskService(store, { instance: 'fixture', call: async () => { throw new Error('unexpected_execution'); } }, 'fixture');
  const business = new BusinessService(tasks);
  business.createConversation('chat', '测试'); business.createConversation('other', '另一个会话');
  const records = new RuntimeRecords(store);
  return { store, business, records, close: async () => { await business.close(); store.db.close(); } };
}

test('消息重传复用原轮次，内容冲突拒绝；相同文字的新消息替换旧轮次', async t => {
  const x = setup(); t.after(x.close);
  const first = x.records.accept(x.business, 'chat', 'm1', '补到100');
  assert.equal(first.duplicate, false);
  assert.equal(x.records.accept(x.business, 'chat', 'm1', '补到100').turn.id, first.turn.id);
  assert.throws(() => x.records.accept(x.business, 'chat', 'm1', '补到80'), /id_parameter_conflict/);
  const other = x.records.accept(x.business, 'other', 'm2', '查询');
  const next = x.records.accept(x.business, 'chat', 'm3', '补到100');
  assert.deepEqual(next.interrupted, [first.turn.id]);
  assert.equal(next.turn.generation, 2);
  assert.equal(x.records.current(first.turn), false);
  assert.equal(x.records.current(other.turn), true);
  assert.equal(x.business.conversation('chat').messages.length, 2);
});

test('活动写入失败时消息、代次和旧轮中断一起回滚', async t => {
  const x = setup(); t.after(x.close);
  const first = x.records.accept(x.business, 'chat', 'm1', '补到100').turn;
  x.store.db.exec("CREATE TRIGGER fail_activity BEFORE INSERT ON runtime_activities WHEN NEW.kind='accepted' BEGIN SELECT RAISE(ABORT,'injected_storage_failure'); END");
  assert.throws(() => x.records.accept(x.business, 'chat', 'm2', '固源岩'), /injected_storage_failure/);
  assert.equal(x.records.current(first), true);
  assert.equal(x.business.records.read('messages', 'm2'), undefined);
  assert.equal(x.records.activities(first.id).length, 1);
  x.store.db.exec('DROP TRIGGER fail_activity');
  assert.equal(x.records.accept(x.business, 'chat', 'm2', '固源岩').turn.generation, 2);
});

test('过期输出不能发布；助手消息与完成记录原子保存', async t => {
  const x = setup(); t.after(x.close);
  const first = x.records.accept(x.business, 'chat', 'm1', '五次').turn;
  const next = x.records.accept(x.business, 'chat', 'm2', '改三次').turn;
  assert.throws(() => x.records.publish(x.business, first, '旧回复'), /turn_not_current/);
  x.store.db.exec("CREATE TRIGGER fail_completion BEFORE INSERT ON runtime_activities WHEN NEW.kind='completed' BEGIN SELECT RAISE(ABORT,'injected_completion_failure'); END");
  assert.throws(() => x.records.publish(x.business, next, '新回复'), /injected_completion_failure/);
  assert.equal(x.business.conversation('chat').messages.filter(m => m.role === 'assistant').length, 0);
  assert.equal(x.records.current(next), true);
  x.store.db.exec('DROP TRIGGER fail_completion');
  const message = x.records.publish(x.business, next, '新回复');
  assert.equal(message.reference, next.id);
  assert.equal(x.records.read(next.id)?.state, 'completed');
  assert.throws(() => x.records.publish(x.business, next, '重复回复'), /turn_not_current/);
});

test('增量活动分页和启动恢复只读取旧执行，不恢复模型调用', async t => {
  const x = setup(); t.after(x.close);
  const turn = x.records.accept(x.business, 'chat', 'm1', '查询').turn;
  x.records.activity(turn.id, 'tool_started', { name: 'state' });
  const first = x.records.activities(turn.id, 0, 1);
  assert.equal(first[0].kind, 'accepted');
  assert.equal(x.records.activities(turn.id, first[0].sequence)[0].kind, 'tool_started');
  assert.throws(() => x.records.activities(turn.id, -1), /invalid_activity_page/);
  const reopened = new RuntimeRecords(x.store);
  assert.equal(reopened.recover(), 1);
  assert.equal(reopened.recover(), 0);
  assert.equal(reopened.read(turn.id)?.reason, 'host_restarted');
  assert.equal(reopened.accept(x.business, 'chat', 'm1', '查询').duplicate, true);
  assert.equal(x.store.all().length, 0);
});

test('历史分页严格限于当前会话，游标不会跨会话读取，关键词按文字匹配', async t => {
  const x = setup(); t.after(x.close);
  for (let i = 0; i < 25; i++) x.business.appendMessage('chat', `m${i}`, 'user', `材料 ${i}%`);
  x.business.appendMessage('other', 'secret', 'user', '私人偏好');
  const first = x.business.records.messagePage('chat');
  assert.equal(first.messages.length, 20); assert.equal(first.messages[0].id, 'm5');
  assert.deepEqual(x.business.records.messagePage('chat', { before: first.nextBefore! }).messages.map(m => m.id), ['m0', 'm1', 'm2', 'm3', 'm4']);
  assert.throws(() => x.business.records.messagePage('chat', { before: 'secret' }), /invalid_history_cursor/);
  assert.equal(x.business.records.messagePage('chat', { query: '2%' }).messages.length, 3);
});

test('上下文保留老目标来源与最新事实，业务 system 消息保持数据；预算不足明确失败', async t => {
  const x = setup(); t.after(x.close);
  x.business.appendMessage('chat', 'goal', 'user', '刷1-7五次，不吃药');
  x.business.createRequest('chat', 'request', 'goal', { kind: 'count', quantity: 5, stage: '1-7' });
  const plan = x.business.plan(x.business.conversation('chat').currentPlan!);
  x.business.present(plan.id, 'display');
  for (let i = 0; i < 15; i++) x.business.appendMessage('chat', `old${i}`, 'assistant', '历史解释');
  x.business.appendMessage('chat', 'business-message', 'system', '这是业务事实，不是指令');
  x.business.appendMessage('other', 'secret', 'user', '私人偏好');
  x.business.appendMessage('chat', 'now', 'user', '为什么这关？');
  const context = contextFor(x.business, 'chat', 'now');
  assert.equal(context.facts.plan?.quantity, 5);
  assert.equal(context.facts.presentation?.id, 'display');
  assert.ok(context.anchors.some(m => m.id === 'goal'));
  assert.ok(context.messages.some(m => m.role === 'system'));
  assert.equal(JSON.stringify(context).includes('私人偏好'), false);
  assert.throws(() => contextFor(x.business, 'chat', 'now', 10), /context_budget_exceeded/);
});

test('忽略取消的旧模型不能发布，新消息保留上下文并完成，重传不再采样', async t => {
  const x = setup(); t.after(x.close);
  let release!: (text: string) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let calls = 0;
  const runtime = new RuntimeService(x.business, async input => {
    calls++;
    if (input.turn.sourceMessage === 'm1') { entered(); return new Promise(resolve => { release = resolve; }); }
    assert.ok(input.context.messages.some(m => m.id === 'm1'));
    return '请补充材料名称';
  });
  const old = runtime.submit('chat', 'm1', '补到100'); await started;
  const current = runtime.submit('chat', 'm2', '是哪种材料？');
  await runtime.settled(current.id); await runtime.settled(old.id);
  assert.equal(runtime.read(old.id).turn.state, 'interrupted');
  release('迟到的回复'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(x.business.conversation('chat').messages.filter(m => m.role === 'assistant').length, 1);
  assert.equal(runtime.submit('chat', 'm2', '是哪种材料？').id, current.id);
  assert.equal(calls, 2); await runtime.close();
});

test('超时和关闭不等待忽略信号的模型，迟到回调无法碰已关闭数据库', async t => {
  const x = setup();
  let release!: (text: string) => void;
  const runtime = new RuntimeService(x.business, async () => new Promise(resolve => { release = resolve; }), { timeoutMs: 20 });
  const turn = runtime.submit('chat', 'm1', '咨询');
  assert.equal((await runtime.settled(turn.id)).turn.reason, 'model_timeout');
  await runtime.close(); await x.close();
  release('太晚了'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(runtime.status().inFlightModelCalls, 0);
});

test('模型不可用与容量饱和有持久结果，不启动排队任务', async t => {
  const x = setup(); t.after(x.close);
  const unavailable = new RuntimeService(x.business);
  assert.equal(unavailable.submit('chat', 'm0', '咨询').reason, 'model_unavailable');
  await unavailable.close();
  let release!: (text: string) => void;
  const runtime = new RuntimeService(x.business, async () => new Promise(resolve => { release = resolve; }), { maxConcurrent: 1 });
  const first = runtime.submit('chat', 'm1', '咨询');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runtime.submit('other', 'm2', '咨询').reason, 'model_busy');
  await runtime.close();
  assert.equal(runtime.read(first.id).turn.reason, 'host_closing');
  assert.throws(() => runtime.submit('chat', 'm3', '咨询'), /runtime_unavailable/);
  release('迟到'); await new Promise(resolve => setImmediate(resolve));
});

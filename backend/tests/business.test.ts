import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.ts';
import { TaskService } from '../src/task-service.ts';
import type { Snapshot, Update } from '../src/task-contract.ts';
import { BusinessService } from '../src/business/service.ts';
import { Catalog, sealCatalog } from '../src/business/catalog.ts';

function setup() {
  const store = new Store(':memory:'); const snapshots = new Map<string, Snapshot>(); let submissions = 0; let stops = 0;
  const tasks = new TaskService(store, { instance: 'fixture', call: async (path, method, body) => {
    if (path === '/executions' && method === 'POST') {
      submissions++; const { id } = body as { id: string };
      snapshots.set(id, { ...store.view(id)!, seq: 1, state: 'accepted', reason: null }); return {};
    }
    const id = path.split('/')[2]?.split('?')[0];
    if (path.endsWith('/stop')) { stops++; return {}; }
    const snapshot = snapshots.get(id)!;
    return { snapshot, events: [{ id, seq: snapshot.seq, kind: 'fixture', source_instance: 'fixture', snapshot }], instance: 'fixture' } as Update;
  } }, 'fixture');
  const business = new BusinessService(tasks);
  async function publish(id: string, changes: Partial<Snapshot>) {
    snapshots.set(id, { ...snapshots.get(id)!, ...changes, seq: snapshots.get(id)!.seq + 1, updated_at: Date.now() / 1000 });
    await tasks.sync(id);
  }
  const completed = { state: 'ended', automation_stopped: true, device: 'ready', reason: 'normal' };
  function request(id: string, goal: unknown, conversation = 'chat') {
    business.createConversation(conversation, conversation);
    business.appendMessage(conversation, `message-${id}`, 'user', `明确目标 ${id}`);
    return business.createRequest(conversation, id, `message-${id}`, goal);
  }
  function currentPlan(conversation = 'chat') { return business.plan(business.conversation(conversation).currentPlan!); }
  async function start() {
    const plan = currentPlan(); business.present(plan.id, `display-${plan.id}`);
    return business.confirm(plan.id, `display-${plan.id}`, `confirm-${plan.id}`, 'button');
  }
  return { store, tasks, business, publish, completed, request, currentPlan, start, submissions: () => submissions, stops: () => stops,
    close: async () => { await business.close(); store.db.close(); } };
}
test('资料快照实际覆盖多个关卡材料，历史统计不等于执行能力承诺', () => {
  const catalog = Catalog.bundled();
  assert.ok(catalog.snapshot.stages.length > 100); assert.ok(Object.keys(catalog.snapshot.items).length > 10);
  assert.equal(catalog.select('1-7', '30012').entry?.apCost, 6);
  assert.ok(catalog.snapshot.coverage.relationships > 100);
});
test('方案展示不执行；并发重复确认只建立一个关联任务，原消息和方案可追溯', async t => {
  const x = setup(); t.after(x.close);
  x.request('request', { kind: 'count', quantity: 5, stage: '1-7' });
  const plan = x.currentPlan();
  await assert.rejects(x.business.confirm(plan.id, 'unshown', 'confirmation', 'button'), /presentation_required/);
  x.business.present(plan.id, 'shown'); assert.equal(x.submissions(), 0);
  const [a,b] = await Promise.all([x.business.confirm(plan.id, 'shown', 'confirmation', 'button'),
    x.business.confirm(plan.id, 'shown', 'duplicate-confirmation', 'button')]);
  assert.equal(a.id, b.id); assert.equal(x.submissions(), 1);
  assert.equal(x.business.records.list('confirmations').length, 1);
  assert.equal(x.business.records.list('task_links')[0].planId, plan.id);
  assert.throws(() => x.business.cancelRequest('request', 1), /use_stop/);
});
test('自然语言确认只授权原方案，重建业务服务后也不能挪用到新方案', async t => {
  const x = setup(); t.after(x.close);
  x.request('first', { kind: 'count', quantity: 1, stage: '1-7' });
  const first = x.currentPlan(); x.business.present(first.id, 'shown-first');
  x.business.appendMessage('chat', 'start-message', 'user', '开始');
  const started = await x.business.confirm(first.id, 'shown-first', 'confirm-first', 'message', 'start-message');
  const retry = await x.business.confirm(first.id, 'shown-first', 'different-transport-id', 'message', 'start-message');
  assert.equal(retry.id, started.id); assert.equal(x.submissions(), 1);
  await x.publish(started.id, { ...x.completed, count_result: { value: 1, certainty: 'exact', issues: [] } });
  x.request('second', { kind: 'count', quantity: 2, stage: '1-7' });
  const second = x.currentPlan(); x.business.present(second.id, 'shown-second');
  await x.business.close();
  const restored = new BusinessService(x.tasks); t.after(() => restored.close());
  await assert.rejects(restored.confirm(second.id, 'shown-second', 'confirm-second', 'message', 'start-message'), /confirmation_message_already_used/);
  assert.equal(x.submissions(), 1); assert.equal(restored.records.list('confirmations').length, 1);
  restored.appendMessage('chat', 'new-start-message', 'user', '按新方案开始');
  await restored.confirm(second.id, 'shown-second', 'confirm-second', 'message', 'new-start-message');
  assert.equal(x.submissions(), 2);
});

test('修订后旧消息及展示前消息不能确认；同毫秒的新消息按持久顺序确认', async t => {
  const x = setup(); t.after(x.close);
  x.request('request', { kind: 'count', quantity: 1, stage: '1-7' });
  x.business.present(x.currentPlan().id, 'shown-old');
  x.business.appendMessage('chat', 'old-start', 'user', '开始');
  x.business.appendMessage('chat', 'revision', 'user', '改成两次并开始');
  x.business.reviseRequest('request', 1, 'revision', { kind: 'count', quantity: 2, stage: '1-7' });
  const plan = x.currentPlan();
  const receipt = x.business.present(plan.id, 'shown-new');
  for (const message of ['old-start', 'revision']) {
    await assert.rejects(x.business.confirm(plan.id, receipt.id, `confirm-${message}`, 'message', message), /confirmation_message_before_presentation/);
  }
  assert.equal(x.submissions(), 0); assert.equal(x.business.records.list('confirmations').length, 0);
  const message = x.business.appendMessage('chat', 'fresh-start', 'user', '按新方案开始');
  x.business.records.save('messages', { ...message, createdAt: receipt.createdAt });
  await x.business.confirm(plan.id, receipt.id, 'confirm-fresh', 'message', message.id);
  assert.equal(x.submissions(), 1);
});

test('旧展示记录缺少消息边界时须重新展示；重复展示回执不移动边界', async t => {
  const x = setup(); t.after(x.close);
  x.request('request', { kind: 'count', quantity: 1, stage: '1-7' });
  const plan = x.currentPlan(); const receipt = x.business.present(plan.id, 'legacy-shown');
  const { lastMessageId: _boundary, ...legacy } = receipt;
  x.business.records.save('plan_presentations', legacy);
  x.business.appendMessage('chat', 'start-message', 'user', '开始');
  await assert.rejects(x.business.confirm(plan.id, receipt.id, 'confirmation', 'message', 'start-message'), /confirmation_message_before_presentation/);
  const fresh = x.business.present(plan.id, 'fresh-shown');
  x.business.appendMessage('chat', 'new-message', 'user', '按重新展示的方案开始');
  assert.deepEqual(x.business.present(plan.id, fresh.id), fresh);
  await x.business.confirm(plan.id, fresh.id, 'confirmation', 'message', 'new-message');
  assert.equal(x.submissions(), 1);
});

test('修订旧方案与取消先于确认时拒绝开始；解释消息不改变当前方案', async t => {
  const x = setup(); t.after(x.close); x.request('request', { kind: 'count', quantity: 10, stage: '1-7' });
  const first = x.currentPlan(); x.business.present(first.id, 'shown');
  x.business.appendMessage('chat', 'explain', 'user', '为什么这样安排');
  assert.equal(x.currentPlan().id, first.id);
  x.business.appendMessage('chat', 'change', 'user', '改成五次并直接开始');
  x.business.reviseRequest('request', 1, 'change', { kind: 'count', quantity: 5, stage: '1-7' });
  await assert.rejects(x.business.confirm(first.id, 'shown', 'bad', 'button'));
  const second = x.currentPlan(); assert.equal(second.state, 'unpresented'); assert.equal(x.submissions(), 0);
  x.business.present(second.id, 'newshown'); x.business.cancelRequest('request', 2);
  await assert.rejects(x.business.confirm(second.id, 'newshown', 'cancelled', 'button'));
});
test('多会话各有方案；占用不消费确认或排队，释放后不会自动开始', async t => {
  const x = setup(); t.after(x.close);
  x.request('a', { kind: 'count', quantity: 1, stage: '1-7' }); const active = await x.start();
  x.request('b', { kind: 'count', quantity: 1, stage: '1-7' }, 'other'); const plan = x.currentPlan('other');
  x.business.present(plan.id, 'other-display');
  await assert.rejects(x.business.confirm(plan.id, 'other-display', 'other-confirm', 'button'), /device_busy/);
  assert.equal(x.business.records.read('confirmations', 'other-confirm'), undefined);
  await x.publish(active.id, { ...x.completed, count_result: { value: 1, certainty: 'exact', issues: [] } });
  assert.equal(x.submissions(), 1); assert.equal(x.currentPlan('other').state, 'presented');
  await x.business.confirm(plan.id, 'other-display', 'other-confirm', 'button'); assert.equal(x.submissions(), 2);
});
test('可靠扫描完成自动准备缺口方案；材料执行结果回原会话且不重复摘要', async t => {
  const x = setup(); t.after(x.close);
  const request = x.request('inventory', { kind: 'inventory', quantity: 100, itemId: '30012', stage: '1-7' });
  assert.deepEqual(request.waiting, ['inventory_required']);
  await x.business.scan('inventory', 1, 'scan', '先扫描库存');
  await x.publish('scan', { ...x.completed, inventory_result: { items: { '30012': 72 }, complete: true,
    certainty: 'recognized', missing_items: 'unknown', observed_at: Date.now() / 1000, issues: [] } });
  assert.equal(x.currentPlan().quantity, 28); assert.equal(x.submissions(), 1);
  const active = await x.start();
  await x.publish(active.id, { ...x.completed, material_result: { items: { '30012': 29 }, certainty: 'exact', issues: [] } });
  assert.equal(x.business.task(active.id).result?.estimatedInventory?.value, 101);
  const messages = x.business.conversation('chat').messages.length; x.business.reconcile(); x.business.reconcile();
  assert.equal(x.business.conversation('chat').messages.length, messages); assert.equal(x.submissions(), 2);
});
test('取消后迟到扫描只留观察和历史，不覆盖新需求', async t => {
  const x = setup(); t.after(x.close);
  x.request('inventory', { kind: 'inventory', quantity: 100, itemId: '30012' });
  await x.business.scan('inventory', 1, 'scan', '先扫描'); x.business.cancelRequest('inventory', 1);
  x.request('count', { kind: 'count', quantity: 5, stage: '1-7' }); const plan = x.currentPlan();
  await x.publish('scan', { ...x.completed, inventory_result: { items: { '30012': 72 }, complete: true,
    certainty: 'recognized', missing_items: 'unknown', observed_at: Date.now() / 1000, issues: [] } });
  assert.equal(x.currentPlan().id, plan.id); assert.ok(x.business.records.read('observations', 'scan'));
});
test('缺失材料不当零；有效库存已满足时不创建刷图方案', async t => {
  const x = setup(); t.after(x.close);
  x.request('inventory', { kind: 'inventory', quantity: 100, itemId: '30012' });
  await x.business.scan('inventory', 1, 'scan', '先扫描');
  await x.publish('scan', { ...x.completed, inventory_result: { items: {}, complete: true,
    certainty: 'recognized', missing_items: 'unknown', observed_at: Date.now() / 1000, issues: [] } });
  assert.equal(x.business.conversation('chat').currentPlan, null); assert.deepEqual(x.business.request('inventory').waiting, ['inventory_required']);
  await x.business.scan('inventory', 1, 'scan-again', '重新扫描');
  await x.publish('scan-again', { ...x.completed, inventory_result: { items: { '30012': 101 }, complete: true,
    certainty: 'recognized', missing_items: 'unknown', observed_at: Date.now() / 1000, issues: [] } });
  assert.equal(x.business.request('inventory').state, 'completed'); assert.equal(x.business.conversation('chat').currentPlan, null);
});
test('已知手动变化使库存方案失效，切换会话本身不失效', async t => {
  const x = setup(); t.after(x.close);
  x.request('inventory', { kind: 'inventory', quantity: 100, itemId: '30012', stage: '1-7' });
  await x.business.scan('inventory', 1, 'scan', '扫描');
  await x.publish('scan', { ...x.completed, inventory_result: { items: { '30012': 72 }, complete: true,
    certainty: 'recognized', missing_items: 'unknown', observed_at: Date.now() / 1000, issues: [] } });
  const plan = x.currentPlan(); x.business.present(plan.id, 'shown');
  x.business.createConversation('other', '另一个会话'); x.business.conversation('other');
  assert.equal(x.currentPlan().state, 'presented');
  x.business.recordInventoryChange('manual', ['30012'], '用户报告手动消耗');
  await assert.rejects(x.business.confirm(plan.id, 'shown', 'confirm', 'button'), /plan_not_current/);
  assert.equal(x.submissions(), 1);
});
test('调整先停止，核对后用精确成果计算剩余；后续多次调整不重复累计', async t => {
  const x = setup(); t.after(x.close); x.request('first', { kind: 'count', quantity: 10, stage: '1-7' });
  const first = await x.start(); x.business.appendMessage('chat', 'adjust-message', 'user', '总共改成五次');
  await x.business.adjust(first.id, 'adjusted', 'adjust-message', { kind: 'count', quantity: 5, stage: '1-7' }, 'total');
  assert.equal(x.stops(), 1); assert.equal(x.business.conversation('chat').currentPlan, null);
  await x.publish(first.id, { ...x.completed, reason: 'user_stop', count_result: { value: 2, certainty: 'exact', issues: [] } });
  assert.equal(x.currentPlan().quantity, 3);
  const second = await x.start(); x.business.appendMessage('chat', 'again-message', 'user', '总共改成六次');
  await x.business.adjust(second.id, 'adjusted-again', 'again-message', { kind: 'count', quantity: 6, stage: '1-7' }, 'total');
  await x.publish(second.id, { ...x.completed, reason: 'user_stop', count_result: { value: 1, certainty: 'exact', issues: [] } });
  assert.equal(x.currentPlan().quantity, 3); assert.equal(x.currentPlan().prior.value, 3);
});
test('调整成果未知不猜剩余；取消调整不会撤回停止或恢复执行', async t => {
  const x = setup(); t.after(x.close); x.request('first', { kind: 'count', quantity: 10, stage: '1-7' });
  const first = await x.start(); x.business.appendMessage('chat', 'adjust-message', 'user', '改成五次');
  await x.business.adjust(first.id, 'adjusted', 'adjust-message', { kind: 'count', quantity: 5, stage: '1-7' }, 'total');
  await x.publish(first.id, { ...x.completed, count_result: { value: 2, certainty: 'lower_bound', issues: ['unsettled'] } });
  assert.equal(x.business.conversation('chat').currentPlan, null);
  assert.deepEqual(x.business.request('adjusted').waiting, ['previous_result_uncertain']);
  x.business.cancelRequest('adjusted', 1); x.business.reconcile(); assert.equal(x.stops(), 1); assert.equal(x.submissions(), 1);
});
test('后续消费者迟到时再次检查请求版本，不能覆盖新需求或重放同一凭据', async t => {
  const x = setup(); t.after(x.close);
  x.request('inventory', { kind: 'inventory', quantity: 100, itemId: '30012' }); await x.business.scan('inventory', 1, 'scan', '扫描');
  await x.publish('scan', { ...x.completed, inventory_result: { items: {}, complete: false, certainty: 'unknown',
    missing_items: 'unknown', observed_at: Date.now() / 1000, issues: ['partial'] } });
  let release!: () => void; const gate = new Promise<void>(r => { release = r; }); let observed = false;
  let started!: () => void; const entered = new Promise<void>(r => { started = r; });
  x.business.setFollowupConsumer(async context => {
    started();
    await gate;
    assert.throws(() => x.business.acceptFollowup(context.record.id, context.record.token!, () => {}), /followup_not_current|request_not_current/); observed = true;
  });
  await entered;
  x.request('new', { kind: 'count', quantity: 2, stage: '1-7' }); const plan = x.currentPlan();
  release(); await new Promise(r => setTimeout(r, 5));
  assert.equal(observed, true); assert.equal(x.currentPlan().id, plan.id);
});
test('扫描期间补充关卡承接当前需求版本；明确查看库存不追问刷取数量', async t => {
  const x = setup(); t.after(x.close);
  x.request('inventory', { kind: 'inventory', quantity: 100, itemId: '30012' }); await x.business.scan('inventory', 1, 'scan', '扫描');
  x.business.appendMessage('chat', 'stage-message', 'user', '用1-7');
  x.business.reviseRequest('inventory', 1, 'stage-message', { kind: 'inventory', quantity: 100, itemId: '30012', stage: '1-7' });
  await x.publish('scan', { ...x.completed, inventory_result: { items: { '30012': 72 }, complete: true,
    certainty: 'recognized', missing_items: 'unknown', observed_at: Date.now() / 1000, issues: [] } });
  assert.equal(x.currentPlan().revision, 2); assert.equal(x.currentPlan().quantity, 28);
  x.business.appendMessage('chat', 'inspect-message', 'user', '看看库存');
  x.business.inspectInventory('chat', 'inspect', 'inspect-message'); await x.business.scan('inspect', 1, 'inspect-scan', '查看库存');
  await x.publish('inspect-scan', { ...x.completed, inventory_result: { items: { '30012': 72 }, complete: true,
    certainty: 'recognized', missing_items: 'unknown', observed_at: Date.now() / 1000, issues: [] } });
  assert.equal(x.business.request('inspect').state, 'completed'); assert.equal(x.business.conversation('chat').currentPlan, null);
  assert.equal(x.business.records.list('continuations').length, 0);
});
test('库存调整重扫后不重复扣除旧收获；执行中手动变更保留成果但库存待核实', async t => {
  const x = setup(); t.after(x.close);
  x.request('inventory', { kind: 'inventory', quantity: 100, itemId: '30012', stage: '1-7' });
  await x.business.scan('inventory', 1, 'scan', '扫描');
  const inventory = (value: number) => ({ items: { '30012': value }, complete: true, certainty: 'recognized', missing_items: 'unknown' as const, observed_at: Date.now() / 1000, issues: [] });
  await x.publish('scan', { ...x.completed, inventory_result: inventory(72) });
  const first = await x.start();
  x.business.recordInventoryChange('manual', ['30012'], '手动改变库存');
  await x.publish(first.id, { ...x.completed, material_result: { items: { '30012': 4 }, certainty: 'exact', issues: [] } });
  assert.equal(x.business.task(first.id).result!.target, 'uncertain');
  assert.equal(x.business.task(first.id).result!.amount.value, 4);
  x.business.appendMessage('chat', 'continue-message', 'user', '继续补到100');
  await x.business.adjust(first.id, 'continued', 'continue-message', { kind: 'inventory', quantity: 100, itemId: '30012', stage: '1-7' }, 'total');
  assert.deepEqual(x.business.request('continued').waiting, ['inventory_required']);
  await x.business.scan('continued', 1, 'rescan', '重新核对库存');
  await x.publish('rescan', { ...x.completed, inventory_result: inventory(80) });
  assert.equal(x.currentPlan().quantity, 20); assert.equal(x.currentPlan().prior.value, 0);
});
test('后续处理失败无自动重试；关闭可取消挂起消费者且迟到写入被拒绝', async t => {
  const x = setup(); t.after(x.close);
  x.request('inventory', { kind: 'inventory', quantity: 100, itemId: '30012' }); await x.business.scan('inventory', 1, 'scan', '扫描');
  await x.publish('scan', { ...x.completed, inventory_result: { items: {}, complete: false, certainty: 'unknown', missing_items: 'unknown', observed_at: 1, issues: [] } });
  let calls = 0;
  x.business.setFollowupConsumer(async () => { calls++; throw new Error('model unavailable'); });
  await new Promise(r => setTimeout(r, 5)); x.business.reconcile();
  assert.equal(calls, 1); assert.equal(x.business.records.list('continuations')[0].state, 'failed');
  x.business.appendMessage('chat', 'retry-input', 'user', '改为补到101');
  x.business.reviseRequest('inventory', 1, 'retry-input', { kind: 'inventory', quantity: 101, itemId: '30012' });
  await x.business.scan('inventory', 2, 'scan2', '重新扫描');
  let started!: () => void; const entered = new Promise<void>(r => { started = r; });
  x.business.setFollowupConsumer(async () => { started(); await new Promise(() => {}); });
  await x.publish('scan2', { ...x.completed, inventory_result: { items: {}, complete: false, certainty: 'unknown', missing_items: 'unknown', observed_at: 2, issues: [] } });
  await entered;
  const pending = x.business.records.list('continuations').find(c => c.state === 'processing')!;
  await x.business.close();
  assert.equal(x.business.records.read('continuations', pending.id)!.state, 'interrupted');
  assert.throws(() => x.business.acceptFollowup(pending.id, pending.token!, () => {}), /business_unavailable/);
});
test('显式激活资料持久保留选择和历史版本；相关变更使旧方案不可开始', async t => {
  const x = setup(); t.after(x.close); x.request('first', { kind: 'count', quantity: 2, stage: '1-7' });
  const plan = x.currentPlan(); x.business.present(plan.id, 'shown');
  const { version: _, ...data } = structuredClone(x.business.catalog.snapshot);
  data.stages.find(s => s.code === '1-7')!.apCost = 7;
  const updated = sealCatalog(data); x.business.activateCatalog(updated);
  assert.equal(x.currentPlan().state, 'stale');
  await assert.rejects(x.business.confirm(plan.id, 'shown', 'confirm', 'button'), /plan_not_current/);
  assert.ok(x.business.records.read('catalogs', plan.catalogVersion));
  await x.business.close(); const rebuilt = new BusinessService(x.tasks); t.after(() => rebuilt.close());
  assert.equal(rebuilt.catalog.snapshot.version, updated.version); assert.equal(x.submissions(), 0);
});
test('同步失败时业务查询同步降级可信度，停止仍不依赖模型', async t => {
  const x = setup(); t.after(x.close); x.request('first', { kind: 'count', quantity: 5, stage: '1-7' });
  const task = await x.start();
  await x.publish(task.id, { count_result: { value: 2, certainty: 'exact', issues: [] }, state: 'running' });
  x.tasks.adapter.call = async () => { throw new Error('offline'); };
  await assert.rejects(x.tasks.sync(task.id));
  assert.equal(x.business.task(task.id).result!.amount.certainty, 'lower_bound');
  assert.equal(x.business.conversation('chat').tasks[0].result!.remaining, null);
  const stopped = await x.business.stop(task.id); assert.equal(stopped.confirmed, false);
  assert.equal(x.business.task(task.id).task.stop_requested, true);
});
test('确认关联写入失败整笔回滚；受理响应丢失保留原确认和任务且不重发', async t => {
  const x = setup(); t.after(x.close); x.request('first', { kind: 'count', quantity: 2, stage: '1-7' });
  const plan = x.currentPlan(); x.business.present(plan.id, 'shown');
  const insert = x.business.records.insert.bind(x.business.records);
  x.business.records.insert = (table, record) => {
    if (table === 'confirmations') throw new Error('confirmation storage failure');
    insert(table, record);
  };
  await assert.rejects(x.business.confirm(plan.id, 'shown', 'confirmation', 'button'), /storage failure/);
  assert.equal(x.store.all().length, 0); assert.equal(x.business.records.list('task_links').length, 0); assert.equal(x.submissions(), 0);
  x.business.records.insert = insert;
  const call = x.tasks.adapter.call;
  x.tasks.adapter.call = async (path, method, body) => {
    const value = await call(path, method, body);
    if (path === '/executions' && method === 'POST') throw new Error('acceptance response lost');
    return value;
  };
  const first = await x.business.confirm(plan.id, 'shown', 'confirmation', 'button');
  const duplicate = await x.business.confirm(plan.id, 'shown', 'another-confirmation', 'button');
  assert.equal(first.id, duplicate.id); assert.equal(x.submissions(), 1);
  assert.equal(first.task.sync.reason, 'submission_not_confirmed');
  assert.equal(x.business.records.list('confirmations').length, 1);
  await x.publish(first.id, { ...x.completed, count_result: { value: 2, certainty: 'exact', issues: [] } });
  assert.equal(x.business.task(first.id).result!.target, 'achieved');
});

for (const scanFinished of [false, true]) {
  test(`查看库存转补库存：扫描${scanFinished ? '已完成' : '进行中'}时统一修订意图、版本和依据`, async t => {
    const x = setup(); t.after(x.close);
    x.business.createConversation('chat', 'chat');
    x.business.appendMessage('chat', 'inspect-message', 'user', '查看库存');
    x.business.inspectInventory('chat', 'inspect', 'inspect-message');
    await x.business.scan('inspect', 1, 'scan', '先查看库存');
    const finish = () => x.publish('scan', { ...x.completed, inventory_result: { items: { '30012': 72 }, complete: true,
      certainty: 'recognized', missing_items: 'unknown', observed_at: Date.now() / 1000, issues: [] } });
    if (scanFinished) await finish();
    x.business.appendMessage('chat', 'revise', 'user', '补到100，用1-7');
    const revised = x.business.reviseRequest('inspect', 1, 'revise', { kind: 'inventory', quantity: 100, itemId: '30012', stage: '1-7' });
    assert.equal(revised.intent, 'execute'); assert.equal(revised.revision, 2);
    if (!scanFinished) { assert.deepEqual(revised.waiting, ['scan_pending']); await finish(); }
    assert.equal(x.currentPlan().quantity, 28); assert.equal(x.currentPlan().revision, 2);
    assert.equal(x.currentPlan().state, 'unpresented'); assert.equal(x.submissions(), 1);
    await finish(); assert.equal(x.business.conversation('chat').plans.length, 1);
  });
}
test('查看库存取消后不能借修订复活；修订后取消的迟到扫描只保留历史', async t => {
  const x = setup(); t.after(x.close);
  x.business.createConversation('chat', 'chat'); x.business.appendMessage('chat', 'message', 'user', '查看库存');
  x.business.inspectInventory('chat', 'inspect', 'message'); await x.business.scan('inspect', 1, 'scan', '查看');
  x.business.appendMessage('chat', 'revise', 'user', '补到100');
  x.business.reviseRequest('inspect', 1, 'revise', { kind: 'inventory', quantity: 100, itemId: '30012' });
  x.business.cancelRequest('inspect', 2);
  assert.throws(() => x.business.reviseRequest('inspect', 2, 'revise', { kind: 'inventory', quantity: 101, itemId: '30012' }), /request_not_current/);
  await x.publish('scan', { ...x.completed, inventory_result: { items: { '30012': 72 }, complete: true,
    certainty: 'recognized', missing_items: 'unknown', observed_at: Date.now() / 1000, issues: [] } });
  assert.equal(x.business.request('inspect').state, 'cancelled');
  assert.equal(x.business.conversation('chat').currentPlan, null); assert.ok(x.business.records.read('observations', 'scan'));
  assert.equal(x.submissions(), 1);
});

test('调整与停止意图同事务；回滚不停止，提交后崩溃可由同步送达停止但不重发执行', async t => {
  const x = setup(); t.after(x.close); x.request('first', { kind: 'count', quantity: 5, stage: '1-7' });
  const task = await x.start(); x.business.appendMessage('chat', 'adjust', 'user', '改成三次');
  const reserve = x.tasks.reserveStop.bind(x.tasks);
  x.tasks.reserveStop = id => { const stop = reserve(id); throw new Error('transaction interrupted'); return stop; };
  await assert.rejects(x.business.adjust(task.id, 'new', 'adjust', { kind: 'count', quantity: 3, stage: '1-7' }, 'total'), /interrupted/);
  assert.equal(x.business.records.read('execution_requests', 'new'), undefined);
  assert.equal(x.tasks.get(task.id).stop_requested, undefined); assert.equal(x.stops(), 0);
  await x.tasks.sync(task.id); assert.equal(x.stops(), 0, '回滚不能留下内存停止意图');
  x.tasks.reserveStop = id => { reserve(id); return { dispatch: async () => { throw new Error('crash after commit'); } }; };
  await assert.rejects(x.business.adjust(task.id, 'new', 'adjust', { kind: 'count', quantity: 3, stage: '1-7' }, 'total'), /crash after commit/);
  assert.equal(x.business.request('new').state, 'active'); assert.equal(x.tasks.get(task.id).stop_requested, true);
  const restored = new TaskService(x.store, x.tasks.adapter, 'fixture');
  await restored.sync(task.id);
  assert.equal(x.stops(), 1); assert.equal(x.submissions(), 1);
});

test('单任务同步只处理受影响关系，不遍历历史任务与会话；启动恢复仍全量核对', async t => {
  const x = setup(); t.after(x.close); x.request('first', { kind: 'count', quantity: 2, stage: '1-7' });
  const task = await x.start();
  x.request('unrelated', { kind: 'count', quantity: 3, stage: '1-7' }, 'other');
  const plan = x.currentPlan('other');
  const all = x.store.all.bind(x.store); const list = x.business.records.list.bind(x.business.records);
  x.store.all = () => { throw new Error('unexpected full task scan'); };
  x.business.records.list = (table, conversation) => {
    if (['conversations', 'task_links', 'execution_requests', 'continuations'].includes(table) && conversation === undefined) throw new Error('unexpected full business scan');
    return list(table, conversation);
  };
  await x.publish(task.id, { ...x.completed, count_result: { value: 2, certainty: 'exact', issues: [] } });
  assert.equal(x.business.request('first').state, 'completed');
  assert.equal(x.business.plan(plan.id).state, 'unpresented'); assert.equal(x.tasks.storageFailed, false);
  x.store.all = all; x.business.records.list = list;
  assert.equal(x.business.global().projection.available, true);
  await x.business.close(); const restored = new BusinessService(x.tasks); t.after(() => restored.close());
  assert.equal(restored.task(task.id).result!.amount.value, 2); assert.equal(x.submissions(), 1);
});
test('业务投影失败保留执行事实与停止能力，恢复只补投影，不重新提交', async t => {
  const x = setup(); t.after(x.close); x.request('first', { kind: 'count', quantity: 5, stage: '1-7' });
  const task = await x.start(); const save = x.business.records.save.bind(x.business.records);
  x.business.records.save = (table, value) => { if (table === 'task_links') throw new Error('projection failed'); save(table, value); };
  await x.publish(task.id, { state: 'running', count_result: { value: 2, certainty: 'exact', issues: [] } });
  assert.equal(x.tasks.storageFailed, false); assert.equal(x.tasks.get(task.id).sync.available, true);
  assert.equal(x.business.global().projection.reason, 'business_projection_failed');
  assert.equal(x.business.global().admission.state, 'unavailable');
  assert.equal(x.business.task(task.id).result!.amount.value, 2);
  assert.throws(() => x.business.createConversation('blocked', 'blocked'), /business_unavailable/);
  assert.throws(() => x.business.appendMessage('chat', 'blocked-message', 'user', '不应写入'), /business_unavailable/);
  assert.equal(x.business.records.read('messages', 'blocked-message'), undefined);
  const stop = await x.business.stop(task.id); assert.equal(stop.stop_requested, true); assert.equal(x.stops(), 1);
  x.business.records.save = save;
  await x.publish(task.id, { ...x.completed, reason: 'user_stop', count_result: { value: 2, certainty: 'exact', issues: [] } });
  assert.equal(x.business.global().projection.available, true); assert.equal(x.business.request('first').state, 'completed');
  assert.equal(x.submissions(), 1);
});

test('消息写入在消费者存储故障和关闭后被拒绝，正常重复消息仍幂等', async t => {
  const x = setup(); t.after(x.close);
  x.request('inventory', { kind: 'inventory', quantity: 100, itemId: '30012' });
  const message = x.business.appendMessage('chat', 'repeat', 'user', '同一条消息');
  assert.deepEqual(x.business.appendMessage('chat', 'repeat', 'user', '同一条消息'), message);
  await x.business.scan('inventory', 1, 'scan', '查看库存');
  await x.publish('scan', { ...x.completed, inventory_result: { items: {}, complete: false, certainty: 'unknown',
    missing_items: 'unknown', observed_at: 1, issues: [] } });
  const save = x.business.records.save.bind(x.business.records);
  x.business.records.save = (table, value) => { if (table === 'continuations') throw new Error('consumer storage failed'); save(table, value); };
  x.business.setFollowupConsumer(async () => {});
  assert.equal(x.business.global().projection.reason, 'followup_storage_failed');
  assert.throws(() => x.business.appendMessage('chat', 'failed', 'user', '不应写入'), /business_unavailable/);
  assert.equal(x.business.records.read('messages', 'failed'), undefined);
  x.business.records.save = save;
  await x.business.close();
  assert.throws(() => x.business.appendMessage('chat', 'closed', 'user', '关闭后不应写入'), /business_unavailable/);
  assert.equal(x.business.records.read('messages', 'closed'), undefined);
});
test('失败的事实与后续处理一起回滚；下一项同步补齐失败范围，提交后才启动消费者', async t => {
  const x = setup(); t.after(x.close); x.request('first', { kind: 'count', quantity: 1, stage: '1-7' });
  const first = await x.start(); await x.publish(first.id, { ...x.completed, count_result: { value: 1, certainty: 'exact', issues: [] } });
  x.request('inventory', { kind: 'inventory', quantity: 100, itemId: '30012' }); await x.business.scan('inventory', 1, 'scan', '查看');
  let calls = 0;
  x.business.setFollowupConsumer(async context => {
    calls++; assert.equal(x.store.db.isTransaction, false);
    assert.ok(x.business.records.read('observations', 'scan'));
    assert.deepEqual(context.request.waiting, ['inventory_required']);
  });
  const insert = x.business.records.insert.bind(x.business.records);
  x.business.records.insert = (table, value) => { if (table === 'continuations') throw new Error('queue write failed'); insert(table, value); };
  await x.publish('scan', { ...x.completed, inventory_result: { items: {}, complete: false, certainty: 'unknown', missing_items: 'unknown', observed_at: 1, issues: [] } });
  assert.equal(x.business.records.read('observations', 'scan'), undefined); assert.equal(calls, 0);
  assert.equal(x.tasks.get('scan').state, 'ended'); assert.equal(x.tasks.storageFailed, false);
  x.business.records.insert = insert; await x.tasks.sync(first.id);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(calls, 1); assert.equal(x.business.global().projection.available, true);
  assert.equal(x.business.records.list('continuations')[0].state, 'completed'); assert.equal(x.submissions(), 2);
});

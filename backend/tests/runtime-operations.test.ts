import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.ts';
import { TaskService } from '../src/task-service.ts';
import { BusinessService } from '../src/business/service.ts';
import { RuntimeOperations } from '../src/runtime/operations.ts';

function setup() {
  const store = new Store(':memory:'); let submissions = 0;
  const tasks = new TaskService(store, { instance: 'fixture', call: async (path, method) => {
    if (path === '/executions' && method === 'POST') { submissions++; return {}; }
    const id = path.split('/')[2]?.split('?')[0];
    if (path.endsWith('/stop')) return {};
    const snapshot = { ...store.view(id)!, seq: 1, state: 'accepted', device: 'busy' };
    return { instance: 'fixture', snapshot, events: [{ id, seq: 1, kind: 'fixture', source_instance: 'fixture', snapshot }] };
  } }, 'fixture');
  const business = new BusinessService(tasks); const operations = new RuntimeOperations(store);
  business.createConversation('chat', '测试'); business.appendMessage('chat', 'm1', 'user', '刷1-7五次');
  business.createRequest('chat', 'request', 'm1', { kind: 'count', quantity: 5, stage: '1-7' });
  const plan = business.plan(business.conversation('chat').currentPlan!);
  business.present(plan.id, 'display'); business.appendMessage('chat', 'm2', 'user', '开始');
  const operation = () => operations.begin('chat', 'm2', 'confirm', { planId: plan.id, presentationId: 'display' }, () => {});
  return { store, business, operations, operation, plan, submissions: () => submissions,
    close: async () => { await business.close(); store.db.close(); } };
}

test('确认与操作关联同事务，关联故障不会预留或提交执行', async t => {
  const x = setup(); t.after(x.close);
  x.store.db.exec("CREATE TRIGGER fail_association BEFORE INSERT ON runtime_operations BEGIN SELECT RAISE(ABORT,'association_failed'); END");
  const operation = x.operation();
  await assert.rejects(operation.async(associate => x.business.confirm(x.plan.id, 'display', operation.id, 'message', 'm2', associate)), /association_failed/);
  assert.equal(x.submissions(), 0); assert.equal(x.store.all().length, 0);
  assert.equal(x.business.plan(x.plan.id).state, 'presented');
  assert.equal(x.operations.read(operation.id), undefined);
  x.store.db.exec('DROP TRIGGER fail_association');
  const result = await operation.async(associate => x.business.confirm(x.plan.id, 'display', operation.id, 'message', 'm2', associate));
  assert.equal(result.state, 'completed'); assert.equal(x.submissions(), 1);
});

test('提交后的结果保存故障保留原关联，重建记录读取不重发', async t => {
  const x = setup(); t.after(x.close);
  x.store.db.exec("CREATE TRIGGER fail_result BEFORE UPDATE ON runtime_operations WHEN json_extract(NEW.body,'$.state')='completed' BEGIN SELECT RAISE(ABORT,'result_failed'); END");
  const operation = x.operation();
  await assert.rejects(operation.async(associate => x.business.confirm(x.plan.id, 'display', operation.id, 'message', 'm2', associate)), /result_failed/);
  assert.equal(x.submissions(), 1);
  const saved = x.operations.read(operation.id)!; assert.equal(saved.state, 'unknown');
  assert.equal(saved.targetId, x.business.plan(x.plan.id).taskId);
  const reopened = new RuntimeOperations(x.store).begin('chat', 'm2', 'confirm', { presentationId: 'display', planId: x.plan.id }, () => {});
  assert.equal(reopened.id, operation.id);
  const recovered = await reopened.async(async () => { throw new Error('must_not_replay'); });
  assert.equal(recovered.targetId, saved.targetId); assert.equal(x.submissions(), 1);
});

test('同步请求修订与关联一起回滚，同来源重复调用只修订一次', async t => {
  const x = setup(); t.after(x.close);
  x.business.appendMessage('chat', 'change', 'user', '改成三次');
  const operation = x.operations.begin('chat', 'change', 'revise', { requestId: 'request', revision: 1, quantity: 3 }, () => {});
  const revise = () => ({ targetId: 'request', result: x.business.reviseRequest('request', 1, 'change', { kind: 'count', quantity: 3, stage: '1-7' }) });
  x.store.db.exec("CREATE TRIGGER fail_association BEFORE INSERT ON runtime_operations BEGIN SELECT RAISE(ABORT,'association_failed'); END");
  assert.throws(() => operation.sync(revise), /association_failed/);
  assert.equal(x.business.request('request').revision, 1);
  x.store.db.exec('DROP TRIGGER fail_association');
  operation.sync(revise); operation.sync(revise);
  assert.equal(x.business.request('request').revision, 2);
  assert.notEqual(x.operations.begin('chat', 'another-message', 'revise', { requestId: 'request', revision: 1, quantity: 3 }, () => {}).id, operation.id);
});

test('最后一次轮次检查失败时确认回滚，扫描关联故障同样不发送', async t => {
  const x = setup(); t.after(x.close);
  await assert.rejects(x.business.confirm(x.plan.id, 'display', 'confirm', 'message', 'm2', () => { throw new Error('turn_not_current'); }), /turn_not_current/);
  assert.equal(x.submissions(), 0);
  x.business.appendMessage('chat', 'inventory', 'user', '查看库存');
  x.business.inspectInventory('chat', 'inspect', 'inventory');
  await assert.rejects(x.business.scan('inspect', 1, 'scan', '先扫描库存', () => { throw new Error('association_failed'); }), /association_failed/);
  assert.equal(x.submissions(), 0); assert.equal(x.store.all().length, 0);
  assert.equal(x.business.request('inspect').scanTask, null);
});

test('调整关联失败回滚新需求与停止意图，已开始任务保持原关联', async t => {
  const x = setup(); t.after(x.close);
  const started = await x.business.confirm(x.plan.id, 'display', 'confirm', 'message', 'm2');
  x.business.appendMessage('chat', 'change', 'user', '总共改成三次');
  await assert.rejects(x.business.adjust(started.id, 'adjustment', 'change', { kind: 'count', quantity: 3, stage: '1-7' }, 'total',
    () => { throw new Error('association_failed'); }), /association_failed/);
  assert.equal(x.business.records.read('execution_requests', 'adjustment'), undefined);
  assert.equal(x.store.view(started.id)?.stop_requested, undefined);
  assert.equal(x.business.conversation('chat').currentRequest, 'request');
  assert.equal(x.business.plan(x.plan.id).taskId, started.id);
});

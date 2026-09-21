import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.ts';
import { TaskService } from '../src/task-service.ts';
import type { Snapshot, Update } from '../src/task-contract.ts';

function setup() {
  const store = new Store(':memory:'); let stops = 0;
  const snapshots = new Map<string, Snapshot>();
  const tasks = new TaskService(store, { instance: 'fixture', call: async (path, method, body) => {
    if (path === '/executions' && method === 'POST') {
      const { id } = body as { id: string };
      snapshots.set(id, { ...store.view(id)!, seq: 1, state: 'accepted', reason: null }); return {};
    }
    if (path.endsWith('/stop')) { stops++; return {}; }
    const id = path.split('/')[2]?.split('?')[0]; const snapshot = snapshots.get(id)!;
    return { snapshot, events: [{ id, seq: snapshot.seq, kind: 'fixture', source_instance: 'fixture', snapshot }], instance: 'fixture' } as Update;
  } }, 'fixture');
  return { store, tasks, stops: () => stops, close: () => store.db.close(),
    start: () => tasks.submit({ id: 'first', params: { version: 2, kind: 'fight_count', stage: '1-7', count: 5, series: 1, medicine: 0, premium: 0 } }) };
}

test('确认业务事务回滚不留任务或发送；已提交预留只能发送一次，重建不重发', async t => {
  const store = new Store(':memory:'); t.after(() => store.db.close());
  let submissions = 0;
  const service = new TaskService(store, { instance: 'fixture', call: async (_path, method) => {
    if (method === 'POST') submissions++;
    throw new Error('lost response');
  } }, 'fixture');
  const payload = { id: 'operation', params: { version: 2, kind: 'scan_inventory' } };
  assert.throws(() => store.transaction(() => { service.reserve(payload); throw new Error('business write failed'); }));
  assert.equal(store.get('operation'), undefined); assert.equal(submissions, 0);
  const reservation = store.transaction(() => service.reserve(payload));
  assert.equal(submissions, 0);
  await reservation.dispatch(); await reservation.dispatch(); await service.submit(payload);
  assert.equal(submissions, 1);
  await assert.rejects(service.submit({ id: 'another', params: payload.params }), /device_busy_or_uncertain/);
  const restarted = new TaskService(store, service.adapter, 'fixture');
  await restarted.submit(payload); assert.equal(submissions, 1);
});

test('停止预留只能事务提交后送达，同一临时凭据不重复发送', async t => {
  const x = setup(); t.after(x.close);
  const task = await x.start();
  const stop = x.store.transaction(() => {
    const reserved = x.tasks.reserveStop(task.id);
    assert.throws(() => reserved.dispatch(), /stop_intent_not_committed/); return reserved;
  });
  await Promise.all([stop.dispatch(), stop.dispatch()]); assert.equal(x.stops(), 1);
});

test('同步观察者异常不冒充执行存储故障，也不跳过已持久化停止的送达', async t => {
  const x = setup(); t.after(x.close);
  const task = await x.start(); x.tasks.reserveStop(task.id);
  x.tasks.onSynchronized = () => { throw new Error('observer bug'); };
  await x.tasks.sync(task.id);
  assert.equal(x.tasks.storageFailed, false); assert.equal(x.tasks.synchronizationObserverFailed, true);
  assert.equal(x.tasks.get(task.id).sync.available, true); assert.equal(x.stops(), 1);
});

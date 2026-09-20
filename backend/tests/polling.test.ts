import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.ts';
import { TaskService } from '../src/task-service.ts';
import type { Snapshot, Update } from '../src/task-contract.ts';

const params = { stage: '1-7' as const, count: 1, medicine: 0 as const, premium: 0 as const };

function setup() {
  const store = new Store(':memory:');
  const remote = new Map<string, Snapshot>();
  const calls: string[] = [];
  const tasks = new TaskService(store, { instance: 'test', async call(path) {
    calls.push(path);
    const id = path.split('/')[2]!.split('?')[0]!;
    return { instance: 'test', snapshot: structuredClone(remote.get(id)!), events: [] } satisfies Update;
  } }, 'offline_callback_replay');
  function add(id: string, changes: Partial<Snapshot> = {}) {
    store.prepare(id, params, 'offline_callback_replay');
    store.mark(id, { state: 'ended', automation_stopped: true, device: 'ready', ...changes });
    remote.set(id, JSON.parse(store.get(id)!.snapshot));
  }
  return { store, remote, calls, tasks, add };
}

test('periodic requests exclude stable history but reconcile startup, active tasks and handoff', async t => {
  const x = setup(); t.after(() => x.store.db.close());
  for (let i = 0; i < 100; i++) x.add(`old-${i}`);
  await x.tasks.poll(); // New host has not yet reconciled persisted history.
  assert.equal(x.calls.length, 100);
  x.calls.length = 0;
  x.add('active', { state: 'running', automation_stopped: false, device: 'occupied' });
  await x.tasks.poll(); await x.tasks.poll();
  assert.deepEqual(x.calls, ['/executions/active?after=0', '/executions/active?after=0']);
  x.remote.get('active')!.state = 'ended';
  x.remote.get('active')!.automation_stopped = true;
  x.remote.get('active')!.device = 'ready';
  await x.tasks.poll();
  assert.equal(x.tasks.get('active').state, 'ended');
  x.calls.length = 0;
  await x.tasks.poll();
  assert.equal(x.calls.length, 0);
  await x.tasks.poll(true);
  assert.equal(x.calls.length, 101);
});

test('lost recheck response keeps terminal task synchronized without resubmission', async t => {
  const x = setup(); t.after(() => x.store.db.close());
  x.add('old', { device: 'needs_check' });
  await x.tasks.poll();
  const original = x.tasks.adapter.call;
  let submissions = 0;
  x.tasks.adapter.call = async (path, method, body) => {
    if (method === 'POST') { submissions++; throw new Error('response lost'); }
    return original(path, method, body);
  };
  await assert.rejects(x.tasks.recheck('old', { id: 'check' }), /response lost/);
  x.calls.length = 0;
  await x.tasks.poll(); // Still sees the old terminal snapshot: acceptance was delayed.
  assert.equal(x.calls.length, 1);
  const snapshot = x.remote.get('old')!;
  snapshot.recheck = { id: 'check', state: 'running', automation_stopped: false, ready: false };
  await x.tasks.poll();
  assert.equal(x.tasks.get('old').recheck?.state, 'running');
  snapshot.recheck = { id: 'check', state: 'ended', automation_stopped: true, ready: true };
  snapshot.device = 'ready';
  await x.tasks.poll();
  assert.equal(x.tasks.get('old').device, 'ready');
  x.calls.length = 0;
  await x.tasks.poll();
  assert.equal(x.calls.length, 0);
  assert.equal(submissions, 1);
});

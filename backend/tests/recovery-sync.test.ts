import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.ts';
import { TaskService } from '../src/task-service.ts';
import { blocksExecution } from '../src/task-contract.ts';
import type { Snapshot, DeviceStatus, Update } from '../src/task-contract.ts';

const params = { stage: '1-7' as const, count: 2, medicine: 0 as const, premium: 0 as const };

// Completion is explicitly controlled: POST and its follow-up sync finish before release.
function fixture() {
  const store = new Store(':memory:');
  const remote = new Map<string, Snapshot>();
  for (const state of ['ended', 'unknown']) {
    store.prepare(state, params, 'offline_callback_replay');
    store.mark(state, { state, automation_stopped: state === 'ended', device: 'needs_check',
      confirmed: 1, started_cycles: 2, unsettled_cycles: 1, reason: 'user_stop' });
    remote.set(state, JSON.parse(store.get(state)!.snapshot));
  }
  let recovery: DeviceStatus['recovery'] = null;
  let lostResponse = false;
  let reads = 0;
  let posts = 0;
  const adapter = { instance: 'test', async call(path: string, method = 'GET') {
    if (path === '/device') return { blockers: [...remote.values()].filter(blocksExecution).map(s =>
      ({ id: s.id, seq: s.seq, confirmed: s.confirmed, certainty: s.certainty, reason: s.reason, kind: 'historical' })),
      recoverable: recovery?.state !== 'running', recovery };
    if (method === 'POST') {
      assert.equal(path, '/takeovers', 'must never replay executions or probes automatically');
      posts++;
      recovery ??= { id: 'check', state: 'running', automation_stopped: false, reason: null };
      if (lostResponse) throw new Error('lost response');
      return recovery;
    }
    reads++;
    const snapshot = structuredClone(remote.get(path.split('/')[2]!.split('?')[0]!)!);
    const after = Number(path.split('after=')[1]);
    return { instance: 'test', snapshot, events: snapshot.seq > after ? [{ id: snapshot.id,
      seq: snapshot.seq, kind: 'takeover', source_instance: 'test', snapshot }] : [] } satisfies Update;
  } };
  const input = { id: 'check', confirmed: true, targets: [...remote.values()].map(({ id, seq }) => ({ id, seq })) };
  function complete(success = true, stopped = true) {
    recovery = { id: 'check', state: success ? 'succeeded' : 'failed', automation_stopped: stopped, reason: success ? null : 'probe_failed' };
    if (success) for (const s of remote.values()) {
      s.seq++;
      s.takeover = { id: 'check', released: true, environment: { ready: true, observed_at: 1, basis: 'fixture', automation_stopped: true } };
    }
  }
  return { store, adapter, remote, input, complete, service: () => new TaskService(store, adapter, 'offline_callback_replay'),
    loseResponse: () => { lostResponse = true; }, reads: () => reads, posts: () => posts };
}

for (const lost of [false, true]) for (const restart of ['none', 'running', 'completed']) {
  test(`delayed takeover synchronizes terminal and unknown history; lost=${lost}, restart=${restart}`, async t => {
    const x = fixture(); t.after(() => x.store.db.close());
    let tasks = x.service();
    await tasks.poll();
    const before = tasks.list();
    if (lost) x.loseResponse();
    if (lost) await assert.rejects(tasks.takeover(x.input), /lost response/);
    else await tasks.takeover(x.input);
    if (restart === 'running') tasks = x.service(); // Persisted Store, discarded all service-local tracking.
    await tasks.poll();
    assert.equal((await tasks.device()).admission.state, 'blocked');
    await assert.rejects(tasks.submit({ id: 'new', params }), /device_busy_or_uncertain/);
    x.complete();
    if (restart === 'completed') tasks = x.service();
    assert.equal((await tasks.device()).admission.state, 'synchronizing');
    await assert.rejects(tasks.submit({ id: 'new', params }), /device_busy_or_uncertain/);
    await tasks.poll(); // Production periodic path only; no forced full reconciliation.
    assert.equal((await tasks.device()).admission.state, 'ready');
    for (const old of before) {
      const after = tasks.get(old.id);
      assert.equal(after.takeover?.released, true);
      for (const key of ['state', 'confirmed', 'certainty', 'reason', 'automation_stopped', 'unsettled_cycles'] as const)
        assert.equal(after[key], old[key]);
    }
    const reads = x.reads();
    await tasks.poll(); await tasks.poll();
    assert.equal(x.reads(), reads, 'released history becomes stable, including old unknown facts');
    assert.equal(x.posts(), 1, 'polling and restart do not resend recovery');
    await tasks.poll(true); // Handoff still reconciles stable records.
    assert.equal(x.reads(), reads + 2);
  });
}

for (const stopped of [false, true]) test(`failed recovery keeps admission blocked; stopped=${stopped}`, async t => {
  const x = fixture(); t.after(() => x.store.db.close());
  const tasks = x.service();
  await tasks.takeover(x.input);
  x.complete(false, stopped);
  await tasks.poll();
  assert.equal((await tasks.device()).admission.state, 'blocked');
  await assert.rejects(tasks.submit({ id: 'new', params }), /device_busy_or_uncertain/);
  assert.equal(x.posts(), 1);
});

test('incomplete evidence cannot become stable or admit work, even after release', async t => {
  const x = fixture(); t.after(() => x.store.db.close());
  const tasks = x.service();
  await tasks.takeover(x.input);
  x.complete();
  x.remote.get('ended')!.seq = 3; // Missing events 1 and 2.
  await tasks.poll();
  assert.equal(tasks.get('ended').gap, true);
  assert.equal((await tasks.device()).admission.state, 'synchronizing');
  await assert.rejects(tasks.submit({ id: 'new', params }), /device_busy_or_uncertain/);
  const reads = x.reads();
  await tasks.poll();
  assert.equal(x.reads(), reads + 1);
});

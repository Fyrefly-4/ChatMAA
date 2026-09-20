import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { repository } from '../src/config.ts';
import { startHost } from '../src/host.ts';
import { createApp } from '../src/app.ts';
import { executionSubmission } from '../src/execution-contract.ts';
import type { TaskView } from '../src/task-contract.ts';
import { Store } from '../src/store.ts';
import type { Snapshot } from '../src/task-contract.ts';
import { uncertainEvidence } from '../src/task-contract.ts';

const scan = { version: 2, kind: 'scan_inventory' };
const material = { version: 2, kind: 'fight_material', stage: '1-7', item_id: '30012', quantity: 3, series: 1, medicine: 0, premium: 0 };
async function until(read: () => TaskView, accept: (v: TaskView) => boolean) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const value = read();
    if (accept(value)) return value;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('D2 evidence did not arrive');
}

test('D2 Backend and real Adapter HTTP persist scan, material, counts and stop independently of models', async t => {
  const dataDir = resolve(repository, '.artifacts/checks', `d2-${Date.now()}`);
  mkdirSync(dataDir, { recursive: true });
  const host = await startHost({ mode: 'maa-replay', python: resolve(repository, 'adapter/maa/.venv/Scripts/python.exe'),
    dataDir, port: 0, pollMs: 50, httpTimeoutMs: 1000, leaseMs: 5000, stopDeadlineMs: 1500 });
  const app = createApp(host.tasks, 'test', () => {});
  t.after(async () => { await app.close(); await host.close(); });
  const submit = (id: string, params: object) => app.inject({ method: 'POST', url: '/tasks', headers: { 'x-app-token': 'test' }, payload: { id, params } });
  assert.equal((await submit('scan', scan)).statusCode, 202);
  await assert.rejects(host.tasks.submit({ id: 'other', params: material }));
  const inventory = await until(() => host.tasks.get('scan'), v => v.state === 'ended');
  assert.equal(inventory.inventory_result?.items['30012'], 72);
  assert.equal(inventory.inventory_result?.complete, true);
  assert.equal(inventory.inventory_result?.missing_items, 'unknown');
  assert.equal(inventory.confirmed, 0);
  assert.equal(inventory.evidence_source, 'synthetic_d2_callbacks');
  assert.equal(inventory.device, 'ready');
  assert.equal((await submit('material', material)).statusCode, 202);
  await host.tasks.submit({ id: 'material', params: material });
  await assert.rejects(host.tasks.submit({ id: 'material', params: { ...material, quantity: 4 } }));
  const drops = await until(() => host.tasks.get('material'), v => v.state === 'ended');
  assert.equal(drops.material_result?.items['30012'], 4);
  assert.equal(drops.material_result?.certainty, 'exact');
  assert.equal(drops.count_result?.value, 2);
  assert.equal(drops.threshold_reached, true);
  assert.equal(drops.gap, false);
  assert.equal((await submit('count', { version: 2, kind: 'fight_count', stage: '2-1', count: 3, series: 2, medicine: 0, premium: 0 })).statusCode, 202);
  const count = await until(() => host.tasks.get('count'), v => v.state === 'ended');
  assert.equal(count.count_result?.value, 2);
  assert.equal(count.count_result?.certainty, 'exact');
  assert.equal(count.threshold_reached, false);
  assert.equal((await submit('limited', { ...material, quantity: 100, max_count: 1 })).statusCode, 202);
  const limited = await until(() => host.tasks.get('limited'), v => v.state === 'ended');
  assert.equal(limited.count_result?.value, 1);
  assert.equal(limited.threshold_reached, false);
  assert.equal((await submit('stop', { ...material, quantity: 10000 })).statusCode, 202);
  await until(() => host.tasks.get('stop'), v => (v.count_result?.value ?? 0) >= 1);
  await host.tasks.stop('stop');
  const stopped = await until(() => host.tasks.get('stop'), v => v.automation_stopped);
  assert.equal(stopped.device, 'needs_check');
  assert.equal(stopped.threshold_reached, false);
  const audit = readFileSync(resolve(dataDir, 'worker-audit.jsonl'), 'utf8').trim().split('\n');
  assert.equal(audit.length, 5);
  const handoff = await host.close();
  assert.equal(handoff.handoffComplete, true);
  assert.equal(handoff.childExited, true);

  // Restart against the same databases: explicit takeover releases admission only.
  const restarted = await startHost({ mode: 'maa-replay', python: resolve(repository, 'adapter/maa/.venv/Scripts/python.exe'),
    dataDir, port: 0, pollMs: 50, httpTimeoutMs: 1000, leaseMs: 5000, stopDeadlineMs: 1500 });
  const restartedApp = createApp(restarted.tasks, 'test', () => {});
  t.after(async () => { await restartedApp.close(); await restarted.close(); });
  assert.equal((await restartedApp.inject({ method: 'GET', url: '/device' })).statusCode, 403);
  const device = (await restartedApp.inject({ method: 'GET', url: '/device', headers: { 'x-app-token': 'test' } })).json();
  assert.equal(device.recoverable, true);
  assert.deepEqual(device.blockers.map((b: { id: string }) => b.id), ['stop']);
  const takeover = { id: 'recover-history', confirmed: true,
    targets: device.blockers.map((b: { id: string; seq: number }) => ({ id: b.id, seq: b.seq })) };
  const release = (body: object) => restartedApp.inject({ method: 'POST', url: '/takeovers',
    headers: { 'x-app-token': 'test' }, payload: body });
  assert.equal((await release({ ...takeover, confirmed: false })).statusCode, 409);
  assert.equal((await release(takeover)).statusCode, 202);
  const released = await until(() => restarted.tasks.get('stop'), v => v.takeover?.released === true);
  assert.deepEqual(released.count_result, stopped.count_result);
  assert.deepEqual(released.material_result, stopped.material_result);
  assert.equal(released.reason, stopped.reason);
  assert.equal((await release(takeover)).statusCode, 202);
  assert.equal(readFileSync(resolve(dataDir, 'worker-audit.jsonl'), 'utf8').trim().split('\n').length, 5);
  await restarted.tasks.submit({ id: 'after-takeover', params: scan });
  await until(() => restarted.tasks.get('after-takeover'), v => v.state === 'ended');
});

test('D2 parameter shape is deterministic and rejects coercions and arbitrary Core options', () => {
  assert.deepEqual(executionSubmission({ id: 'scan', params: scan }), { id: 'scan', params: scan });
  for (const params of [{ ...scan, count: 1 }, { ...material, quantity: true }, { ...material, version: 3 },
    { ...material, medicine: 1 }, { ...material, medicine_expire_days: 1 }, { ...material, series: 0 },
    { ...material, item_id: '' }, { ...material, quantity: 0 }]) {
    assert.throws(() => executionSubmission({ id: 'invalid', params }));
  }
});

test('D2 transport gaps and conflicting sequence never retain exact or complete projections', t => {
  const directory = resolve(repository, '.artifacts/checks', `d2-store-${Date.now()}`);
  mkdirSync(directory, { recursive: true });
  const store = new Store(resolve(directory, 'business.sqlite'));
  t.after(() => store.db.close());
  store.prepare('scan', executionSubmission({ id: 'scan', params: scan }).params, 'fixture');
  const snapshot: Snapshot = { ...store.view('scan')!, seq: 2, state: 'ended', automation_stopped: true, device: 'ready',
    inventory_result: { items: { '30012': 72 }, complete: true, certainty: 'recognized', missing_items: 'unknown', observed_at: 1, issues: [] },
    material_result: { items: { '30012': 4 }, certainty: 'exact', issues: [] },
    count_result: { value: 2, certainty: 'exact', issues: [] }, threshold_reached: true };
  const evidence = { id: 'scan', seq: 2, kind: 'final', source_instance: 'fixture', snapshot };
  store.apply('scan', { instance: 'fixture', snapshot, events: [evidence] });
  let result = store.view('scan')!;
  assert.equal(result.gap, true);
  assert.equal(result.inventory_result?.complete, false);
  assert.equal(result.material_result?.certainty, 'lower_bound');
  store.apply('scan', { instance: 'fixture', snapshot, events: [{ ...evidence, kind: 'conflict' }] });
  result = store.view('scan')!;
  assert.equal(result.evidence_conflict, true);
  assert.equal(result.material_result?.certainty, 'unknown');
  assert.equal(result.threshold_reached, false);
  const interrupted = uncertainEvidence(result, 'adapter_exit');
  assert.equal(interrupted.material_result?.certainty, 'unknown');
  assert.equal(interrupted.count_result?.certainty, 'unknown');
  assert.equal(interrupted.threshold_reached, false);
});

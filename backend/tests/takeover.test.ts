import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startHost } from '../src/host.ts';
import { repository } from '../src/config.ts';
import { seedUncertain } from './takeover-fixture.ts';

test('lost takeover response reconciles without replay; same-directory restart preserves old facts and admits a new task', async () => {
  const dataDir = resolve(repository, '.artifacts/checks', `takeover-${randomUUID()}`);
  mkdirSync(dataDir, { recursive: true });
  seedUncertain(dataDir);
  const config = { python: resolve(repository, 'adapter/maa/.venv/Scripts/python.exe'),
    port: 0, dataDir, mode: 'maa-replay' as const, pollMs: 40, httpTimeoutMs: 500, leaseMs: 5000, stopDeadlineMs: 1500 };
  let host = await startHost(config);
  try {
    await host.tasks.poll(true);
    const before = host.tasks.get('history');
    const device = await host.tasks.device();
    assert.equal(device.recoverable, true);
    const input = { id: 'manual', confirmed: true, targets: device.blockers.map(({ id, seq }) => ({ id, seq })) };
    const call = host.tasks.adapter.call;
    host.tasks.adapter.call = async (path, method, body) => {
      const result = await call(path, method, body);
      if (path === '/takeovers') throw new Error('lost response');
      return result;
    };
    await assert.rejects(host.tasks.takeover(input));
    host.tasks.adapter.call = call;
    for (let i = 0; i < 100 && !host.tasks.get('history').takeover?.released; i++) {
      await new Promise(r => setTimeout(r, 30)); await host.tasks.poll(true);
    }
    const after = host.tasks.get('history');
    assert.equal(after.takeover?.released, true);
    for (const key of ['state', 'confirmed', 'certainty', 'automation_stopped', 'device', 'reason', 'unsettled_cycles'] as const) {
      assert.equal(after[key], before[key]);
    }
    const closed = await host.close();
    assert.equal(closed.handoffComplete, true);
    assert.equal(closed.finalTasks[0].reason, before.reason);
    host = await startHost(config);
    await host.tasks.poll(true);
    const seq = host.tasks.get('history').seq;
    await host.tasks.takeover(input);
    assert.equal(host.tasks.get('history').seq, seq);
    await host.tasks.submit({ id: 'new', params: { stage: '1-7', count: 1, medicine: 0, premium: 0 } });
    for (let i = 0; i < 100 && host.tasks.get('new').state !== 'ended'; i++) await new Promise(r => setTimeout(r, 30));
    assert.equal(host.tasks.get('new').confirmed, 1);
  } finally { await host.close(); }
});

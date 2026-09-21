import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { repository } from '../src/config.ts';

const execute = promisify(execFile);
test('默认 MVP 进程与独立 CLI 先展示再确认，裸提交拒绝，退出完整交接', async () => {
  const data = resolve(repository, '.artifacts/checks', `business-cli-${Date.now()}`); mkdirSync(data, { recursive: true });
  const config = resolve(data, 'config.json');
  writeFileSync(config, JSON.stringify({ mode: 'maa-replay', dataDir: data,
    python: resolve(repository, 'adapter/maa/.venv/Scripts/python.exe'), pollMs: 60, httpTimeoutMs: 1000, leaseMs: 5000, stopDeadlineMs: 3000 }));
  const env = { ...process.env, CHATMAA_CONFIG: config };
  const server = spawn(process.execPath, [resolve(repository, 'backend/src/main.ts')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let errors = ''; let exited = false; let index = 0;
  server.stdout.on('data', chunk => { output += chunk; }); server.stderr.on('data', chunk => { errors += chunk; });
  const exit = new Promise<void>(resolve => server.once('exit', () => { exited = true; resolve(); }));
  const cli = async (...args: string[]) => (await execute(process.execPath,
    [resolve(repository, 'backend/src/business/cli.ts'), ...args], { env, windowsHide: true, timeout: 10000 })).stdout;
  async function operation(value: object) {
    const file = resolve(data, `operation-${++index}.json`); writeFileSync(file, JSON.stringify(value));
    return JSON.parse(await cli('operation', file));
  }
  try {
    const deadline = Date.now() + 15000;
    while (!existsSync(resolve(data, 'connection.json')) && !exited && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    assert(!exited, errors); assert(existsSync(resolve(data, 'connection.json')), errors);
    assert.equal(JSON.parse(readFileSync(resolve(data, 'connection.json'), 'utf8')).entry, 'mvp');
    await operation({ operation: 'create_conversation', id: 'chat', title: 'CLI验证' });
    await operation({ operation: 'append_message', conversationId: 'chat', id: 'message', role: 'user', text: '刷1-7一次' });
    await operation({ operation: 'create_request', conversationId: 'chat', id: 'request', sourceMessage: 'message', goal: { kind: 'count', quantity: 1, stage: '1-7' } });
    const conversation = JSON.parse(await cli('conversation', 'chat')); const plan = conversation.currentPlan;
    assert.match(await cli('present', plan, 'shown'), /"quantity": 1/);
    const task = await operation({ operation: 'confirm_plan', planId: plan, presentationId: 'shown', id: 'confirmation', source: 'button' });
    let final = JSON.parse(await cli('task', task.id));
    const until = Date.now() + 8000;
    while (final.task.state !== 'ended' && Date.now() < until) {
      await new Promise(r => setTimeout(r, 50)); final = JSON.parse(await cli('task', task.id));
    }
    assert.equal(final.result.target, 'achieved');
    await assert.rejects(execute(process.execPath, [resolve(repository, 'backend/src/cli.ts'), 'submit', '1', 'bypass'],
      { env, windowsHide: true, timeout: 10000 }));
    assert.equal(readFileSync(resolve(data, 'worker-audit.jsonl'), 'utf8').trim().split('\n').length, 1);
    await assert.rejects(execute(process.execPath, [resolve(repository, 'backend/src/main.ts'), '--web'],
      { env, windowsHide: true, timeout: 10000 }), /legacy-demo/);
  } finally {
    if (!exited && existsSync(resolve(data, 'connection.json'))) await execute(process.execPath,
      [resolve(repository, 'backend/src/cli.ts'), 'shutdown'], { env, windowsHide: true, timeout: 10000 }).catch(() => {});
    await Promise.race([exit, new Promise<void>(r => setTimeout(r, 6000).unref())]);
    if (!exited) { server.kill(); await exit; throw new Error('业务 CLI 验证服务未正常退出'); }
  }
  const shutdown = output.trim().split('\n').map(line => JSON.parse(line)).find(row => row.kind === 'shutdown');
  assert.equal(shutdown.childExited, true); assert.equal(shutdown.handoffComplete, true);
});

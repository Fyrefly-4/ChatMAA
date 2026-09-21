import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { repository } from '../src/config.ts';

const execute = promisify(execFile);
test('真实模型样例入口必须显式授权参数且拒绝 live，不启动执行端', async () => {
  const data = resolve(repository, '.artifacts/checks', `runtime-samples-guard-${Date.now()}`); mkdirSync(data, { recursive: true });
  const script = resolve(repository, 'backend/src/runtime/samples.ts');
  await assert.rejects(execute(process.execPath, [script], { windowsHide: true, timeout: 5000 }), /allow-model/);
  const config = resolve(data, 'live.json');
  writeFileSync(config, JSON.stringify({ mode: 'maa-live', installation: data, hwnd: 1 }));
  await assert.rejects(execute(process.execPath, [script, '--allow-model'], {
    env: { ...process.env, CHATMAA_CONFIG: config }, windowsHide: true, timeout: 5000 }), /拒绝 live/);
  assert.equal(existsSync(resolve(data, 'connection.json')), false);
});
test('独立 Runtime 无模型进程与 CLI：消息可见、打印展示、防重和退出；不读取模型凭据', async () => {
  const data = resolve(repository, '.artifacts/checks', `runtime-cli-${Date.now()}`); mkdirSync(data, { recursive: true });
  const config = resolve(data, 'config.json');
  writeFileSync(config, JSON.stringify({ mode: 'maa-replay', dataDir: data,
    python: resolve(repository, 'adapter/maa/.venv/Scripts/python.exe'), pollMs: 60, httpTimeoutMs: 1000, leaseMs: 5000, stopDeadlineMs: 3000 }));
  const env = { ...process.env, CHATMAA_CONFIG: config, DEEPSEEK_API_KEY: 'must-not-be-used' };
  const server = spawn(process.execPath, [resolve(repository, 'backend/src/main.ts'), '--runtime', '--no-model'],
    { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let errors = ''; let exited = false;
  server.stdout.on('data', chunk => { output += chunk; }); server.stderr.on('data', chunk => { errors += chunk; });
  const exit = new Promise<void>(resolve => server.once('exit', () => { exited = true; resolve(); }));
  const cli = async (...args: string[]) => (await execute(process.execPath,
    [resolve(repository, 'backend/src/runtime/cli.ts'), ...args], { env, windowsHide: true, timeout: 10000 })).stdout;
  try {
    const deadline = Date.now() + 15000;
    while (!existsSync(resolve(data, 'connection.json')) && !exited && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    assert(!exited, errors); assert(existsSync(resolve(data, 'connection.json')), errors);
    const connection = JSON.parse(readFileSync(resolve(data, 'connection.json'), 'utf8'));
    assert.equal(connection.entry, 'mvp-runtime');
    async function operation(body: object) {
      const result = await fetch(`${connection.address}/business/operations`, { method: 'POST',
        headers: { 'x-app-token': connection.token, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      assert.equal(result.status, 200); return result.json();
    }
    await cli('new', 'chat', '独立 Runtime');
    assert.match(await cli('message', 'chat', 'message', '刷1-7一次'), /model_unavailable/);
    assert.match(await cli('status'), /"available": false/);
    await operation({ operation: 'create_request', conversationId: 'chat', id: 'request', sourceMessage: 'message',
      goal: { kind: 'count', quantity: 1, stage: '1-7' } });
    const shown = await cli('show', 'chat');
    assert.ok(shown.indexOf('"quantity": 1') < shown.lastIndexOf('"lastMessageId"'));
    const conversation = await fetch(`${connection.address}/runtime/conversations/chat`, { headers: { 'x-app-token': connection.token } }).then(r => r.json());
    const plan = conversation.business.currentPlan;
    const receipt = conversation.presentation;
    assert.equal(receipt.id, `cli-${plan}`);
    await cli('show', 'chat');
    assert.match(await cli('message', 'chat', 'message', '刷1-7一次'), /model_unavailable/);
    await assert.rejects(cli('message', 'chat', 'message', '不同内容'));
    assert.equal(existsSync(resolve(data, 'worker-audit.jsonl')), false);
    await cli('confirm', plan, receipt.id, 'confirmation');
    const until = Date.now() + 8000;
    let state = '';
    do { state = await cli('state', 'chat'); if (state.includes('"target": "achieved"')) break; await new Promise(r => setTimeout(r, 50)); } while (Date.now() < until);
    assert.match(state, /"target": "achieved"/);
    assert.equal(readFileSync(resolve(data, 'worker-audit.jsonl'), 'utf8').trim().split('\n').length, 1);
    await assert.rejects(execute(process.execPath, [resolve(repository, 'backend/src/main.ts'), '--runtime', '--legacy-demo'],
      { env, windowsHide: true, timeout: 10000 }), /MVP/);
  } finally {
    if (!exited && existsSync(resolve(data, 'connection.json'))) await execute(process.execPath,
      [resolve(repository, 'backend/src/cli.ts'), 'shutdown'], { env, windowsHide: true, timeout: 10000 }).catch(() => {});
    await Promise.race([exit, new Promise<void>(r => setTimeout(r, 6000).unref())]);
    if (!exited) { server.kill(); await exit; throw new Error('Runtime CLI 服务未正常退出'); }
  }
  const shutdown = output.trim().split('\n').map(line => JSON.parse(line)).find(row => row.kind === 'shutdown');
  assert.equal(shutdown.childExited, true); assert.equal(shutdown.handoffComplete, true);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { startHost } from '../src/host.ts';
import { repository } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import { BrowserRequests } from '../src/browser/requests.ts';

const run = resolve(repository, '.artifacts/checks', `browser-${Date.now()}`);
const result = (content: LanguageModelV4GenerateResult['content']): LanguageModelV4GenerateResult => ({
  content, finishReason: { unified: content.some(c => c.type === 'tool-call') ? 'tool-calls' : 'stop', raw: undefined },
  usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [],
});
const call = result([{ type: 'tool-call', toolCallId: 'submit', toolName: 'submit_task',
  input: JSON.stringify({ stage: '1-7', count: 10, medicine: 0, premium: 0 }) }]);
const reply = result([{ type: 'text', text: '以执行证据为准。' }]);
async function until(check: () => boolean) {
  const deadline = Date.now() + 6000;
  while (!check()) { if (Date.now() > deadline) throw new Error('condition timed out'); await new Promise(r => setTimeout(r, 20)); }
}
async function setup(name: string, timeoutMs = 5000, stall = false) {
  const dataDir = resolve(run, name); mkdirSync(dataDir, { recursive: true });
  const host = await startHost({ python: resolve(repository, 'adapter/maa/.venv/Scripts/python.exe'), mode: 'maa-replay',
    dataDir, port: 0, pollMs: 40, httpTimeoutMs: 500, leaseMs: 5000, stopDeadlineMs: 1500 });
  let calls = 0;
  let finish!: (value: LanguageModelV4GenerateResult) => void;
  const model = new MockLanguageModelV4({ doGenerate: async () => {
    if (++calls === 1) return call;
    return stall ? new Promise(resolve => { finish = resolve; }) : reply;
  } });
  const requests = new BrowserRequests(host.tasks, model, { timeoutMs });
  writeFileSync(resolve(dataDir, 'index.html'), '<h1>测试构建</h1>');
  const app = createApp(host.tasks, 'cli-token', () => {}, { requests, token: 'web-token', staticRoot: dataDir,
    origin: () => 'http://127.0.0.1:43210', developmentOrigin: 'http://127.0.0.1:5173' });
  await app.ready();
  const request = (method: 'GET' | 'POST', url: string, payload?: object, headers: Record<string, string> = {}) =>
    app.inject({ method, url, payload, headers: { host: '127.0.0.1:43210', 'x-web-token': 'web-token', ...headers } });
  const audit = () => { try { return readFileSync(resolve(dataDir, 'worker-audit.jsonl'), 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
  return { host, requests, app, request, audit, finish: () => finish(reply),
    close: async () => { await requests.close(); await app.close(); return host.close(); } };
}

test('browser summary receipt gates formal replay; duplicate requests do not execute twice', async t => {
  const x = await setup('normal'); t.after(x.close);
  const input = { requestId: 'one', original: '刷1-7十次' };
  assert.equal((await x.request('POST', '/api/requests', input)).statusCode, 202);
  await until(() => !!x.requests.read('one').pendingSummary);
  const receipt = x.requests.read('one').pendingSummary!;
  assert.equal(x.host.tasks.list().length, 0); assert.equal(x.audit().length, 0);
  assert.equal((await x.request('POST', '/api/requests', input)).statusCode, 202);
  assert.equal((await x.request('POST', '/api/requests', { ...input, original: '你好' })).statusCode, 409);
  assert.equal((await x.request('POST', '/api/requests', { ...input, requestId: 'two' })).statusCode, 409);
  assert.equal((await x.request('POST', '/api/requests/one/summary-displayed', { ...receipt, receiptId: 'wrong' })).statusCode, 409);
  assert.equal(x.audit().length, 0);
  assert.equal((await x.request('POST', '/api/requests/one/summary-displayed', receipt)).statusCode, 200);
  await x.request('POST', '/api/requests/one/summary-displayed', receipt);
  await until(() => x.host.tasks.list()[0]?.state === 'ended');
  assert.equal(x.host.tasks.list()[0].confirmed, 10); assert.equal(x.audit().length, 1);
  await until(() => !x.requests.busy);
  assert.equal((await x.request('POST', '/api/requests', input)).statusCode, 202);
  assert.equal((await x.request('POST', '/api/requests/one/summary-displayed', receipt)).statusCode, 409);
  assert.equal(x.audit().length, 1);
});

test('summary timeout and shutdown cannot release late execution', async t => {
  for (const close of [false, true]) {
    const x = await setup(`timeout-${close}`, close ? 5000 : 200); t.after(x.close);
    x.requests.submit({ requestId: 'one', original: '刷1-7十次' });
    await until(() => !!x.requests.read('one').pendingSummary);
    const receipt = x.requests.read('one').pendingSummary!;
    if (close) await x.requests.close(); else await until(() => !x.requests.busy);
    assert.equal(x.requests.read('one').record.status, 'failed');
    assert.throws(() => x.requests.acknowledge('one', receipt));
    assert.equal(x.host.tasks.list().length, 0); assert.equal(x.audit().length, 0);
  }
});

test('stalled model explanation leaves independent task stop available; late SDK callbacks are closed', async t => {
  const x = await setup('stalled-model', 5000, true); t.after(x.close);
  x.requests.submit({ requestId: 'one', original: '刷1-7十次' });
  await until(() => !!x.requests.read('one').pendingSummary);
  x.requests.acknowledge('one', x.requests.read('one').pendingSummary);
  await until(() => x.requests.read('one').events.some(e => e.kind === 'tool_result'));
  const id = x.requests.read('one').record.operationId;
  assert.equal(x.requests.busy, true);
  assert.equal((await x.request('GET', `/api/tasks/${id}`)).statusCode, 200);
  assert.equal((await x.request('POST', `/api/tasks/${id}/stop`)).statusCode, 202);
  const closed = await x.close();
  assert.equal(closed.childExited, true);
  x.finish();
  await new Promise(r => setTimeout(r, 50));
});

test('browser credential and origin scope preserve CLI and private-file boundaries', async t => {
  const x = await setup('security'); t.after(x.close);
  assert.equal((await x.request('GET', '/api/status')).statusCode, 200);
  for (const origin of ['http://127.0.0.1:43210', 'http://127.0.0.1:5173']) {
    assert.equal((await x.request('GET', '/api/status', undefined, { origin })).statusCode, 200);
  }
  for (const headers of [{ origin: 'https://evil.example' }, { host: 'evil.example' }, { 'x-web-token': 'cli-token' }] as Record<string, string>[]) {
    assert.equal((await x.request('GET', '/api/status', undefined, headers)).statusCode, 403);
  }
  assert.equal((await x.request('POST', '/shutdown')).statusCode, 403);
  assert.equal((await x.request('GET', '/tasks', undefined, { 'x-app-token': 'cli-token', origin: 'http://127.0.0.1:43210' })).statusCode, 403);
  assert.equal((await x.request('GET', '/tasks', undefined, { 'x-app-token': 'cli-token' })).statusCode, 200);
  assert.equal((await x.request('GET', '/')).statusCode, 200);
  for (const path of ['/docs/user/本地协作入口.md', '/.env', '/assets/../../.env']) {
    assert.notEqual((await x.request('GET', path)).statusCode, 200);
  }
});

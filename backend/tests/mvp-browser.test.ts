import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.ts';
import { TaskService } from '../src/task-service.ts';
import { BusinessService } from '../src/business/service.ts';
import { RuntimeService } from '../src/runtime/service.ts';
import { createApp } from '../src/app.ts';
import { MvpQueries } from '../src/browser/mvp-queries.ts';
import { resolve } from 'node:path';

async function setup() {
  const store = new Store(':memory:'); let submissions = 0; let stops = 0;
  const tasks = new TaskService(store, { instance: 'fixture', call: async (path, method) => {
    if (path === '/device') return { blockers: [], recoverable: false, recovery: null };
    if (path === '/executions' && method === 'POST') { submissions++; return {}; }
    if (path.endsWith('/stop')) { stops++; return {}; }
    throw new Error('controlled unavailable feedback');
  } }, 'fixture');
  const business = new BusinessService(tasks); const runtime = new RuntimeService(business);
  const app = createApp(tasks, 'app-secret', () => {}, {
    token: 'browser-secret', staticRoot: resolve('web/dist'), origin: () => 'http://127.0.0.1:43210',
    developmentOrigin: 'http://127.0.0.1:5173',
  }, business, runtime);
  await app.ready();
  const request = (method: 'GET' | 'POST', url: string, payload?: object, headers: Record<string, string> = {}) =>
    app.inject({ method, url, payload, headers: { host: '127.0.0.1:43210', origin: 'http://127.0.0.1:43210', 'x-web-token': 'browser-secret', ...headers } });
  return { store, tasks, business, runtime, request, q: new MvpQueries(business, runtime),
    submissions: () => submissions, stops: () => stops,
    close: async () => { await runtime.close(); await app.close(); await business.close(); store.db.close(); } };
}

test('MVP 浏览器身份隔离、白名单和无模型消息读取', async t => {
  const x = await setup(); t.after(x.close);
  for (const headers of [{ host: 'evil.test' }, { origin: 'http://evil.test' }, { 'x-web-token': 'app-secret' }] as Record<string, string>[])
    assert.equal((await x.request('GET', '/api/status', undefined, headers)).statusCode, 403);
  assert.equal((await x.request('GET', '/business/status', undefined, { 'x-app-token': 'app-secret' })).statusCode, 403);
  assert.equal((await x.request('POST', '/api/tasks', {})).statusCode, 404);
  assert.equal((await x.request('POST', '/api/conversations', { id: 'chat', title: '会话' })).statusCode, 200);
  assert.equal((await x.request('POST', '/api/messages', { conversationId: 'chat', messageId: 'one', text: '你好', role: 'assistant' })).statusCode, 422);
  const sent = await x.request('POST', '/api/messages', { conversationId: 'chat', messageId: 'one', text: '你好' });
  assert.equal(sent.statusCode, 202); await x.runtime.settled(sent.json().id);
  const found = await x.request('GET', '/api/conversations/chat/messages/one');
  assert.equal(found.json().turn.reason, 'model_unavailable');
  assert.equal((await x.request('GET', '/api/status')).json().runtime.available, false);
  assert.equal((await x.request('GET', '/api/conversations/chat/messages')).json().messages.length, 1);
  assert.equal(x.submissions(), 0);
});

test('消息与轮次双向分页不漏历史、拒绝跨会话游标，读取不生成轮次', async t => {
  const x = await setup(); t.after(x.close);
  x.business.createConversation('chat', '会话'); x.business.createConversation('other', '另一会话');
  for (let i = 0; i < 55; i++) x.business.appendMessage('chat', `m-${i}`, 'user', `消息${i}`);
  const recent = x.q.messages('chat'); assert.equal(recent.messages.length, 20); assert.equal(recent.messages[0].id, 'm-35');
  const previous = x.q.messages('chat', recent.nextBefore!); assert.equal(previous.messages[0].id, 'm-15');
  let cursor = 'm-0'; const ids: string[] = [];
  for (;;) { const page = x.q.messages('chat', undefined, cursor); ids.push(...page.messages.map(m => m.id)); cursor = page.nextAfter!; if (!page.hasMore) break; }
  assert.equal(ids.length, 54); assert.equal(new Set(ids).size, 54);
  assert.throws(() => x.q.messages('other', 'm-0'), /invalid_history_cursor/);
  for (let i = 0; i < 25; i++) { const turn = x.runtime.submit('chat', `turn-${i}`, '咨询'); await x.runtime.settled(turn.id); }
  const turns = x.q.turns('chat'); assert.equal(turns.turns.length, 20);
  assert.equal(x.q.turns('chat', turns.nextBefore!).turns.length, 5);
  const latest = x.q.turns('chat', undefined, 20); assert.equal(latest.turns.length, 5);
  assert.equal((await x.request('GET', '/api/conversations/chat/turns?after=NaN')).statusCode, 422);
  assert.equal(x.submissions(), 0);
});

test('展示与确认分离、强制按钮来源、重复确认唯一执行，故障下直接停止', async t => {
  const x = await setup(); t.after(x.close);
  x.business.createConversation('chat', '会话'); x.business.appendMessage('chat', 'goal', 'user', '刷一次');
  x.business.createRequest('chat', 'request', 'goal', { kind: 'count', stage: '1-7', quantity: 1 });
  const plan = x.q.conversation('chat').plan!;
  assert.equal((await x.request('POST', `/api/plans/${plan.id}/confirm`, { id: 'confirm', presentationId: 'missing' })).statusCode, 409);
  await x.request('POST', `/api/plans/${plan.id}/present`, { id: 'shown' }); assert.equal(x.submissions(), 0);
  assert.equal((await x.request('POST', `/api/plans/${plan.id}/confirm`, { id: 'confirm', presentationId: 'shown', source: 'message' })).statusCode, 422);
  const started = await x.request('POST', `/api/plans/${plan.id}/confirm`, { id: 'confirm', presentationId: 'shown' });
  assert.equal(started.statusCode, 200); const id = started.json().id;
  const duplicate = await x.request('POST', `/api/plans/${plan.id}/confirm`, { id: 'confirm-again', presentationId: 'shown' });
  assert.equal(duplicate.json().id, id); assert.equal(x.submissions(), 1);
  x.tasks.storageFailed = true;
  assert.equal((await x.request('POST', `/api/tasks/${id}/stop`, {})).statusCode, 202); assert.equal(x.stops(), 1);
  assert.equal((await x.request('GET', `/api/tasks/${id}`)).statusCode, 200);
});

test('任务证据分页保留序号缺口，不由快照生成事件；方案读取使用历史资料', async t => {
  const x = await setup(); t.after(x.close);
  x.store.prepare('task', { stage: '1-7', count: 1, medicine: 0, premium: 0 }, 'fixture');
  for (let seq = 1; seq <= 105; seq++) {
    if (seq === 4) continue;
    x.store.db.prepare('INSERT INTO evidence VALUES(?,?,?)').run('task', seq, JSON.stringify({ id: 'task', seq, kind: 'fixture', source_instance: 'fixture', snapshot: x.store.view('task') }));
  }
  const first = x.q.evidence('task', 0); assert.equal(first.events.length, 100); assert.equal(first.hasMore, true);
  assert.equal(first.events.some(e => e.seq === 4), false);
  assert.equal(x.q.evidence('task', first.nextAfter).events.length, 4);
  x.business.createConversation('chat', '会话'); x.business.appendMessage('chat', 'goal', 'user', '刷一次');
  x.business.createRequest('chat', 'request', 'goal', { kind: 'count', stage: '1-7', quantity: 1 });
  const plan = x.q.conversation('chat').plan!;
  assert.ok(Object.keys(plan.sources).length); assert.equal(plan.catalogVersion, x.business.catalog.snapshot.version);
  assert.equal(x.submissions(), 0);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { startHost } from '../src/host.ts';
import { repository } from '../src/config.ts';
import { AgentRequests } from '../src/agent/requests.ts';
import { authorize } from '../src/agent/policy.ts';
import type { AgentEvent } from '../src/agent/records.ts';

const run = resolve(repository, '.artifacts/checks', `agent-${Date.now()}`);
const params = (count = 10) => ({ stage: '1-7', count, medicine: 0, premium: 0 });
const result = (content: LanguageModelV4GenerateResult['content']): LanguageModelV4GenerateResult => ({
  content, finishReason: { unified: content.some(c => c.type === 'tool-call') ? 'tool-calls' : 'stop', raw: undefined },
  usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [],
});
const calls = (...inputs: unknown[]) => result(inputs.map((input, i) => ({ type: 'tool-call', toolCallId: `call-${i}`, toolName: 'submit_task', input: JSON.stringify(input) })));
const reply = result([{ type: 'text', text: '请以任务执行证据为准。' }]);
const mock = (...responses: LanguageModelV4GenerateResult[]) => new MockLanguageModelV4({ doGenerate: responses });
async function setup(name: string) {
  const dataDir = resolve(run, name); mkdirSync(dataDir, { recursive: true });
  const host = await startHost({ python: resolve(repository, 'adapter/maa/.venv/Scripts/python.exe'),
    mode: 'maa-replay', dataDir, port: 0, pollMs: 40, httpTimeoutMs: 500, leaseMs: 5000, stopDeadlineMs: 1500 });
  const audit = () => {
    try { return readFileSync(resolve(dataDir, 'worker-audit.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(x => JSON.parse(x)); }
    catch { return []; }
  };
  return { host, audit };
}
async function until(check: () => boolean) {
  const end = Date.now() + 8000;
  while (!check()) { if (Date.now() > end) throw new Error('observable condition timed out'); await new Promise(r => setTimeout(r, 30)); }
}

test('full expression permission preserves count and refuses conditions instead of dropping them', () => {
  for (const [text, count] of [['帮我刷 1-7 十次', 10], ['请刷1-7 2147483647次，不吃药不碎石', 2147483647], ['刷1-7二十三次', 23]] as const) {
    assert.deepEqual(authorize(text), { action: 'submit', params: params(count) });
  }
  for (const text of ['能不能刷1-7十次', '不要刷1-7十次', '举例：帮我刷1-7十次', '如果可以就刷1-7十次',
    '刷1-7十次，允许吃药', '刷1-7十次再刷2-1一次', '刷1-7', '刷2-1十次', '刷1-7 0次', '刷1-7 2147483648次', '刷1-7十次，五分钟内完成']) {
    assert.equal(authorize(text).action, 'none', text);
  }
});

test('SDK tools use formal service, summary precedes submit, parallel calls and replay execute once', async t => {
  const x = await setup('normal'); t.after(() => x.host.close());
  const model = mock(calls(params(), params()), reply);
  const agent = new AgentRequests(x.host.tasks, model);
  const events: AgentEvent[] = [];
  const input = { requestId: 'one', original: '帮我刷 1-7 十次' };
  const view = await agent.handle(input, async event => {
    if (event.kind === 'summary') { assert.equal(x.host.tasks.list().length, 0); assert.equal(x.audit().length, 0); }
    events.push(event);
  });
  assert.equal(view.record.status, 'finished');
  assert.equal(events.filter(e => e.kind === 'summary').length, 1);
  assert.equal(model.doGenerateCalls.length, 2);
  assert.equal(model.doGenerateCalls[1].tools?.length ?? 0, 0);
  const id = view.record.operationId;
  await until(() => x.host.tasks.get(id).state === 'ended');
  assert.equal(x.host.tasks.get(id).confirmed, 10);
  assert.equal(x.host.tasks.get(id).evidence_source, 'offline_callback_replay');
  await agent.handle(input, async () => {});
  await new AgentRequests(x.host.tasks, mock()).handle(input, async () => {});
  await assert.rejects(agent.handle({ ...input, original: '刷1-7二十次' }, async () => {}), /request_id_conflict/);
  assert.equal(x.audit().length, 1);
  assert.equal(model.doGenerateCalls.length, 2);
});

test('forced model calls cannot authorize unsupported original text or changed parameters', async t => {
  const x = await setup('denied'); t.after(() => x.host.close());
  const originals = ['能不能刷1-7十次', '刷1-7', '不要刷1-7十次', '举例：帮我刷1-7十次', '如果够就刷1-7十次',
    '刷1-7十次吃药', '刷2-1十次', '刷1-7十次再刷2-1一次'];
  for (const [index, original] of originals.entries()) {
    await new AgentRequests(x.host.tasks, mock(calls(params()), reply)).handle({ requestId: `deny-${index}`, original }, async () => {});
  }
  for (const [index, input] of [params(20), { ...params(), stage: '2-1' }, { ...params(), medicine: 1 }, { ...params(), authorized: true }].entries()) {
    await new AgentRequests(x.host.tasks, mock(calls(input), reply)).handle({ requestId: `change-${index}`, original: '刷1-7十次' }, async () => {});
  }
  assert.equal(x.host.tasks.list().length, 0); assert.equal(x.audit().length, 0);
});

test('busy rejection is permanent for a request, direct stop works while model explanation fails', async t => {
  const x = await setup('busy'); t.after(() => x.host.close());
  let steps = 0;
  const model = new MockLanguageModelV4({ doGenerate: async () => {
    if (steps++ === 0) return calls(params(100));
    throw new Error('provider unavailable');
  } });
  const first = await new AgentRequests(x.host.tasks, model).handle({ requestId: 'first', original: '刷1-7 100次' }, async () => {});
  assert.equal(first.record.status, 'failed');
  const agent = new AgentRequests(x.host.tasks, mock(calls(params()), reply));
  const input = { requestId: 'busy', original: '刷1-7十次' };
  await agent.handle(input, async () => {});
  await x.host.tasks.stop(first.record.operationId);
  await until(() => x.host.tasks.get(first.record.operationId).automation_stopped);
  await agent.handle(input, async () => {});
  assert.equal(x.audit().length, 1);
  assert.equal(x.host.tasks.list().length, 1);
});

test('failed summary, cancellation and a late provider result cannot submit', async t => {
  const x = await setup('cancel'); t.after(() => x.host.close());
  const agent = new AgentRequests(x.host.tasks, mock(calls(params()), reply));
  await agent.handle({ requestId: 'summary', original: '刷1-7十次' }, async event => {
    if (event.kind === 'summary') throw new Error('display unavailable');
  });
  let release!: (value: LanguageModelV4GenerateResult) => void;
  const late = new AgentRequests(x.host.tasks, new MockLanguageModelV4({ doGenerate: () => new Promise(ok => { release = ok; }) }));
  const pending = late.handle({ requestId: 'late', original: '刷1-7十次' }, async () => {}, { timeoutMs: 50 });
  await until(() => !!release);
  const view = await pending;
  assert.equal(view.record.status, 'failed');
  release(calls(params()));
  await new Promise(r => setTimeout(r, 80));
  assert.equal(x.host.tasks.list().length, 0); assert.equal(x.audit().length, 0);
});

test('trace storage failure before submit blocks; after submit retains independent task control', async t => {
  const x = await setup('trace'); t.after(() => x.host.close());
  const before = new AgentRequests(x.host.tasks, mock(calls(params()), reply));
  before.records.event = () => { throw new Error('disk full'); };
  await before.handle({ requestId: 'before', original: '刷1-7十次' }, async () => {});
  assert.equal(x.host.tasks.list().length, 0);
  const after = new AgentRequests(x.host.tasks, mock(calls(params(100)), reply));
  const save = after.records.event.bind(after.records);
  after.records.event = (id, event) => { if (event.kind === 'tool_result') throw new Error('disk full'); save(id, event); };
  const view = await after.handle({ requestId: 'after', original: '刷1-7 100次' }, async () => {});
  assert.equal(view.record.error, 'trace_or_display_incomplete');
  assert.equal(view.record.status, 'failed');
  assert.equal(x.host.tasks.list().length, 1);
  await x.host.tasks.stop(view.record.operationId);
  await until(() => x.host.tasks.get(view.record.operationId).automation_stopped);
  assert.equal(x.audit().length, 1);
  await after.handle({ requestId: 'after', original: '刷1-7 100次' }, async () => {});
  assert.equal(x.audit().length, 1);
});

test('explicit bound query and stop preserve task facts; model cannot choose another ID', async t => {
  const x = await setup('control'); t.after(() => x.host.close());
  await x.host.tasks.submit({ id: 'selected', params: params(100) });
  const toolCall = (toolName: string, input: unknown = {}) => result([{ type: 'tool-call', toolCallId: 'control', toolName, input: JSON.stringify(input) }]);
  const query = new AgentRequests(x.host.tasks, mock(toolCall('get_task'), reply));
  const q = await query.handle({ requestId: 'query', original: '查询当前任务', targetId: 'selected' }, async () => {});
  const event = q.events.find(e => e.kind === 'tool_result')!;
  const facts = (event.data as { result: Record<string, unknown> }).result;
  for (const key of ['certainty', 'sync', 'gap', 'automation_stopped', 'device', 'reason']) assert(key in facts);
  const bad = new AgentRequests(x.host.tasks, mock(toolCall('stop_task', { id: 'selected' }), reply));
  await bad.handle({ requestId: 'bad-stop', original: '停止当前任务', targetId: 'selected' }, async () => {});
  assert.equal(x.host.tasks.get('selected').stop_requested, undefined);
  const stop = new AgentRequests(x.host.tasks, mock(toolCall('stop_task'), reply));
  await stop.handle({ requestId: 'stop', original: '停止当前任务', targetId: 'selected' }, async () => {});
  await until(() => x.host.tasks.get('selected').automation_stopped);
  assert.equal(x.audit().length, 1);
});

test('model claiming execution without a call leaves the task ledger empty', async t => {
  const x = await setup('false-claim'); t.after(() => x.host.close());
  const agent = new AgentRequests(x.host.tasks, mock(result([{ type: 'text', text: '已执行十次。' }])));
  const events: AgentEvent[] = [];
  const view = await agent.handle({ requestId: 'claim', original: '刷1-7十次' }, async e => { events.push(e); });
  assert.equal(view.task, null);
  assert.equal((events.find(e => e.kind === 'reply')!.data as { submitted: boolean }).submitted, false);
  assert.equal(x.audit().length, 0);
});

test('unknown tools, different parallel parameters and second-step tool calls cannot add execution', async t => {
  const x = await setup('tool-boundaries'); t.after(() => x.host.close());
  const unknown = mock(result([{ type: 'tool-call', toolCallId: 'unknown', toolName: 'shell', input: '{}' }]), reply);
  const denied = await new AgentRequests(x.host.tasks, unknown).handle({ requestId: 'unknown', original: '刷1-7十次' }, async () => {});
  assert.equal(denied.task, null);
  assert(denied.events.some(e => e.kind === 'model_tools' && JSON.stringify(e.data).includes('shell')));
  const model = mock(calls(params(), params(20)), calls(params()));
  const view = await new AgentRequests(x.host.tasks, model).handle({ requestId: 'parallel', original: '刷1-7十次' }, async () => {});
  await until(() => x.host.tasks.get(view.record.operationId).state === 'ended');
  assert.equal(x.audit().length, 1); assert.equal(x.host.tasks.get(view.record.operationId).confirmed, 10);
  assert.equal(model.doGenerateCalls.length, 2);
});

test('restart reads interrupted intent without resuming, and lost submission response never resends', async t => {
  const x = await setup('restart');
  const first = new AgentRequests(x.host.tasks, mock(calls(params()), reply));
  const call = x.host.tasks.adapter.call;
  x.host.tasks.adapter.call = async (path, method, body) => {
    const value = await call(path, method, body);
    if (path === '/executions') throw new Error('lost response');
    return value;
  };
  const input = { requestId: 'lost', original: '刷1-7十次' };
  const view = await first.handle(input, async () => {});
  await until(() => x.host.tasks.get(view.record.operationId).state === 'ended');
  const interrupted = { ...view.record, requestId: 'interrupted', operationId: 'never-submitted', status: 'running' as const };
  first.records.create(interrupted);
  await x.host.close();
  const restarted = await startHost({ python: resolve(repository, 'adapter/maa/.venv/Scripts/python.exe'),
    mode: 'maa-replay', dataDir: resolve(run, 'restart'), port: 0, pollMs: 40, httpTimeoutMs: 500, leaseMs: 5000, stopDeadlineMs: 1500 });
  t.after(() => restarted.close());
  const model = mock(); const second = new AgentRequests(restarted.tasks, model);
  const persisted = await second.handle(input, async () => {});
  assert.equal(persisted.record.operationId, view.record.operationId);
  const stopped = await second.handle({ ...input, requestId: 'interrupted' }, async () => {});
  assert.equal(stopped.record.status, 'interrupted'); assert.equal(stopped.task, null);
  assert.equal(model.doGenerateCalls.length, 0); assert.equal(x.audit().length, 1);
});

test('task query and stop stay available while model explanation is stalled', async t => {
  const x = await setup('stalled'); t.after(() => x.host.close());
  let explaining = false; let complete!: (value: LanguageModelV4GenerateResult) => void;
  const model = new MockLanguageModelV4({ doGenerate: async () => {
    if (!explaining) { explaining = true; return calls(params(100)); }
    return new Promise(ok => { complete = ok; });
  } });
  const agent = new AgentRequests(x.host.tasks, model);
  const pending = agent.handle({ requestId: 'stalled', original: '刷1-7 100次' }, async () => {});
  await until(() => !!complete);
  const task = agent.read('stalled').task!;
  assert.equal(task.params.count, 100);
  await x.host.tasks.stop(task.id);
  await until(() => x.host.tasks.get(task.id).automation_stopped);
  agent.cancel('stalled');
  assert.equal((await pending).record.status, 'failed');
  complete(reply);
  assert.equal(x.audit().length, 1);
});

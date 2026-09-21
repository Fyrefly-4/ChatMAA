// Deterministic presentation data, not evidence from a game or a model.
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { PlanView, BusinessTask, MvpConversation, MvpStatus, Message, Turn } from '../src/mvp/api';

export const plan: PlanView = {
  adjustment: null, relatedTasks: [],
  id: 'plan', conversationId: 'chat', requestId: 'request', revision: 1,
  goal: { kind: 'inventory', quantity: 100, itemId: '30012', stage: '1-7' }, quantity: 28, stage: '1-7',
  catalogVersion: 'fixture-version', catalogBasis: 'fixture-basis', selection: 'user', explanation: '沿用明确选定的关卡；适用关系来自资料快照。',
  estimate: { sanity: 168, reason: '历史均值参考，不保证本次产量。' }, observationId: 'scan', initialInventory: 72,
  prior: { value: 0, certainty: 'exact' }, resources: { medicine: 0, premium: 0, expiringMedicine: 0 },
  endConditions: ['达到目标', '现有理智不足', '用户停止', '执行或反馈异常'], limitations: ['材料停止可能超过目标。'],
  previousTasks: [], state: 'presented', taskId: null, createdAt: '2026-09-21T06:20:00Z',
  presentation: { id: 'shown', conversationId: 'chat', planId: 'plan', createdAt: '2026-09-21T06:20:00Z', lastMessageId: 'message' },
  itemName: '固源岩', sources: { '资料快照（夹具）': { url: 'https://example.com/source', revision: 'fixture', sha256: '0'.repeat(64), fetchedAt: '2026-09-21T06:00:00Z' } },
  observation: { id: 'scan', conversationId: 'chat', taskId: 'scan', items: { '30012': 72 }, observedAt: 1790000000,
    reliable: true, changeSequence: 0, evidenceSequence: 1 },
};
export const task: BusinessTask = {
  id: 'task', conversationId: 'chat', requestId: 'request', requestRevision: 1, planId: 'plan', purpose: 'fight', origin: 'mvp', resultDigest: 'fixture',
  plan: { ...plan, state: 'started', taskId: 'task' },
  task: { id: 'task', params: { version: 2, kind: 'fight_material', stage: '1-7', item_id: '30012', quantity: 28, series: 1, medicine: 0, premium: 0 },
    seq: 3, state: 'running', confirmed: 2, certainty: 'exact', device: 'needs_check', reason: null, automation_stopped: false,
    started_cycles: 2, unsettled_cycles: 0, evidence_source: 'presentation_fixture', cursor: 3, gap: false,
    sync: { available: true, last_success_at: 1790000020, reason: null }, updated_at: 1790000020 },
  result: { execution: { state: 'running', automationStopped: false, reason: null }, process: 'running', target: 'not_achieved',
    amount: { value: 12, certainty: 'exact' }, cumulative: { value: 12, certainty: 'exact' }, initialInventory: 72,
    estimatedInventory: { value: 84, certainty: 'exact' }, remaining: 16, differenceFromConfirmed: 16, rescanned: false },
};
export const scenarios = ['plan', 'scan', 'material', 'count', 'running', 'cross', 'adjust', 'stopping', 'unknown', 'partial', 'model-failure'] as const;
export type Scene = typeof scenarios[number];
export function sceneData(scene: Scene) {
  const p = structuredClone(plan); const t = structuredClone(task);
  const messages: Message[] = [{ id: 'message', conversationId: 'chat', role: 'user', text: '帮我把固源岩补到100个。', createdAt: p.createdAt },
    { id: 'reply', conversationId: 'chat', role: 'assistant', text: '根据已取得的依据，准备了以下方案。', createdAt: p.createdAt },
    { id: 'plan-message', conversationId: 'chat', role: 'system', text: '请阅读方案并确认。', reference: p.id, createdAt: p.createdAt }];
  if (scene === 'material' || scene === 'count' || scene === 'adjust') {
    p.goal = scene === 'material' ? { kind: 'material', quantity: 20, itemId: '30012', stage: '1-7' } : { kind: 'count', quantity: 5, stage: '1-7' };
    p.quantity = p.goal.quantity; p.observation = null; p.observationId = null; p.initialInventory = null;
  }
  let withTask = ['running', 'cross', 'adjust', 'stopping', 'unknown', 'partial', 'model-failure', 'scan'].includes(scene);
  if (scene === 'adjust') {
    p.quantity = 3; p.previousTasks = ['task']; p.prior = { value: 2, certainty: 'exact' }; p.revision = 2;
    t.task.state = 'ended'; t.task.automation_stopped = true; t.task.device = 'ready';
    t.result = { ...t.result!, process: 'stopped', target: 'not_achieved', amount: { value: 2, certainty: 'exact' }, cumulative: { value: 2, certainty: 'exact' }, initialInventory: null, estimatedInventory: null, remaining: 8 };
  } else if (scene === 'stopping') { t.task.state = 'stopping'; t.task.stop_requested = true; }
  else if (scene === 'unknown') {
    t.task.state = 'unknown'; t.task.gap = true; t.task.sync.available = false;
    t.result = { ...t.result!, process: 'unknown', target: 'uncertain', amount: { value: 12, certainty: 'lower_bound' }, cumulative: { value: 12, certainty: 'lower_bound' }, estimatedInventory: { value: 84, certainty: 'lower_bound' }, remaining: null };
  } else if (scene === 'partial') {
    t.task.state = 'ended'; t.task.automation_stopped = true; t.task.device = 'ready'; t.task.reason = 'sanity_insufficient';
    t.result = { ...t.result!, process: 'partial' };
  } else if (scene === 'scan') {
    t.purpose = 'inventory'; t.planId = null; t.plan = null; t.result = null; t.task.params = { version: 2, kind: 'scan_inventory' };
  }
  if (withTask) messages.push({ id: 'task-message', conversationId: 'chat', role: 'system', text: scene === 'scan' ? '先扫描库存，再计算缺口。' : '任务状态独立更新。', reference: 'task', createdAt: p.createdAt });
  const currentPlan = ['scan'].includes(scene) ? null : p.id;
  if (['running', 'stopping', 'unknown', 'partial', 'model-failure'].includes(scene)) { p.state = 'started'; p.taskId = t.id; }
  if (scene === 'scan') messages.splice(2, 1);
  const cid = scene === 'cross' ? 'other' : 'chat';
  if (scene === 'cross') { p.conversationId = 'other'; p.presentation!.conversationId = 'other'; messages.forEach(m => m.conversationId = 'other'); messages.pop(); }
  const conversation: MvpConversation = { id: cid, conversationId: cid, title: scene === 'cross' ? '关卡咨询' : '补充固源岩', currentRequest: 'request', currentPlan,
    createdAt: p.createdAt, request: null, plan: currentPlan ? p : null, activeTasks: withTask && scene !== 'cross' ? [t] : [] };
  const status: MvpStatus = { entry: 'mvp-runtime', mode: 'offline_callback_replay', projection: { available: true, reason: null },
    admission: { state: withTask && !t.task.automation_stopped ? 'blocked' : 'ready', conflictingTaskIds: withTask && !t.task.automation_stopped ? ['task'] : [] },
    tasks: withTask && !t.task.automation_stopped ? [t] : [], conversations: [{ id: 'chat', conversationId: 'chat', title: '补充固源岩', currentRequest: 'request', currentPlan: 'plan', createdAt: p.createdAt },
      ...(scene === 'cross' ? [{ id: 'other', conversationId: 'other', title: '关卡咨询', currentRequest: 'request', currentPlan: 'plan', createdAt: p.createdAt }] : [])],
    catalogVersion: 'fixture-version', runtime: { available: scene !== 'model-failure', closing: false, storageFailed: false, active: 0, inFlightModelCalls: 0 },
    closing: false, adapterAvailable: true, storageFailed: false, device: { blockers: [], recovery: null, recoverable: false, admission: { state: withTask && !t.task.automation_stopped ? 'blocked' : 'ready', conflictingTaskIds: withTask && !t.task.automation_stopped ? ['task'] : [] } } };
  const turn: Turn = { id: 'turn', conversationId: cid, sourceMessage: 'message', generation: 1, state: scene === 'model-failure' ? 'failed' : 'completed',
    reason: scene === 'model-failure' ? 'model_unavailable' : null, createdAt: p.createdAt, finishedAt: p.createdAt };
  return { plan: p, task: t, conversation, messages, status, turn, withTask };
}

export async function presentationPage(page: Page, state: ReturnType<typeof sceneData>, calls: string[] = []) {
  await page.route('http://chatmaa.test/**', async route => {
    const url = new URL(route.request().url()); const path = url.pathname;
    if (path.startsWith('/api')) calls.push(`${route.request().method()} ${path}${url.search}`);
    if (path === '/api/status') return route.fulfill({ json: state.status });
    if (/^\/api\/conversations\/[^/]+$/.test(path)) return route.fulfill({ json: state.conversation });
    if (path.endsWith('/messages')) return route.fulfill({ json: { messages: url.searchParams.has('after') ? [] : state.messages, hasMore: false, nextBefore: null, nextAfter: state.messages.at(-1)?.id,
      plans: state.conversation.currentPlan ? [state.plan] : [], tasks: state.withTask && state.conversation.id !== 'other' ? [state.task] : [] } });
    if (path.endsWith('/turns')) return route.fulfill({ json: { turns: url.searchParams.has('after') ? [] : [state.turn], hasMore: false, nextBefore: null, nextAfter: 1 } });
    if (path === '/api/turns/turn') return route.fulfill({ json: { turn: state.turn, activities: [] } });
    if (path === '/api/plans/plan') return route.fulfill({ json: state.plan });
    if (path === '/api/tasks/task') return route.fulfill({ json: state.task });
    if (path === '/api/tasks/task/events') return route.fulfill({ json: { events: [], hasMore: false, nextAfter: 0 } });
    if (path === '/api/tasks/task/stop') return route.fulfill({ json: { requested: true } });
    if (path.startsWith('/api/')) return route.fulfill({ status: 404, json: { error: 'fixture_missing_route' } });
    const file = resolve(import.meta.dirname, '../dist', path === '/' ? 'index.html' : path.slice(1));
    return route.fulfill({ body: await readFile(file), contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.goto('http://chatmaa.test/#token=fixture');
}

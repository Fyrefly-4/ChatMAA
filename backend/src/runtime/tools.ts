import { tool, jsonSchema } from 'ai';
import type { BusinessService } from '../business/service.ts';
import { TaskError } from '../task-contract.ts';
import { RuntimeOperations } from './operations.ts';
import type { RunInput } from './service.ts';
import { contextFor } from './context.ts';

type Input = Record<string, unknown>;
const string = { type: 'string' as const, minLength: 1, maxLength: 1000 };
const revision = { type: 'integer' as const, minimum: 1 };
const goal = { type: 'object' as const, additionalProperties: false, properties: {
  kind: { type: 'string' as const, enum: ['count', 'material', 'inventory'] }, quantity: { type: 'integer' as const, minimum: 1, maximum: 2147483647 },
  itemId: string, stage: { ...string, description: '用户明确指定的关卡。材料目标未指定时省略，由 Backend 保留默认候选与资料来源；不要把工具推荐填作用户指定。' } } };
function text(input: Input, key: string) {
  if (typeof input[key] !== 'string' || !input[key]) throw new TaskError(422, 'invalid_tool_input');
  return input[key] as string;
}
function version(input: Input) {
  if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 1) throw new TaskError(422, 'invalid_tool_input');
  return Number(input.revision);
}

export function businessTools(business: BusinessService, run: RunInput, options: {
  readOnly?: boolean; emit: (kind: string, data: unknown) => void;
  track: <T>(work: Promise<T>) => Promise<T>;
}) {
  const operations = new RuntimeOperations(business.tasks.store);
  const { conversationId, sourceMessage } = run.turn;
  let calls = 0; let stepMutated = false; let failed = false; let waitingForExecution = false;
  const check = () => { run.assertCurrent(); if (failed) throw new TaskError(503, 'tool_storage_or_runtime_failed'); };
  const request = (id: string) => {
    const value = business.request(id);
    if (value.conversationId !== conversationId) throw new TaskError(403, 'object_outside_conversation');
    return value;
  };
  const plan = (id: string) => {
    const value = business.plan(id);
    if (value.conversationId !== conversationId) throw new TaskError(403, 'object_outside_conversation');
    return value;
  };
  const task = (id: string, global = false) => {
    const value = business.task(id);
    if (value.conversationId !== conversationId && !(global && business.global().tasks.some(t => t.id === id)))
      throw new TaskError(403, 'object_outside_conversation');
    return value;
  };
  function define(name: string, description: string, properties: Record<string, object>, required: string[], mutate: boolean,
    execute: (input: Input, operation: ReturnType<RuntimeOperations['begin']>) => unknown | Promise<unknown>) {
    if (mutate && name !== 'confirm_plan') properties = { ...properties, intentMessageId: { ...string,
      description: '省略时为当前消息；承接被中断的旧意图时必须选 pendingSources 中对应的原始消息 ID。新独立意图使用当前消息。' } };
    return tool({ description, inputSchema: jsonSchema<Input>({ type: 'object', additionalProperties: false, properties, required }),
      execute: async (input, context) => {
        check();
        if (waitingForExecution) return { error: 'execution_wait_requires_new_turn' };
        if (++calls > 12) return { error: 'tool_budget_exceeded' };
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !(key in properties)) ||
            required.some(key => !(key in input))) return { error: 'invalid_tool_input' };
        try {
          options.emit('tool_call', { callId: context.toolCallId, name, input });
          if (mutate) {
            if (options.readOnly) throw new TaskError(403, 'followup_read_only');
            if (stepMutated) throw new TaskError(409, 'read_updated_facts_in_next_step');
            // SDK executes calls in parallel. Claim synchronously before entering any async operation.
            stepMutated = true;
          }
          const { intentMessageId, ...parameters } = input;
          const source = intentMessageId === undefined ? sourceMessage : text(input, 'intentMessageId');
          if (mutate && !(run.turn.sourceMessages ?? [sourceMessage]).includes(source)) throw new TaskError(403, 'untrusted_intent_source');
          const message = business.records.read('messages', source);
          if (!message || message.role !== 'user' || message.conversationId !== conversationId) throw new TaskError(403, 'untrusted_intent_source');
          const operation = operations.begin(conversationId, source, name, parameters, check);
          const pending = Promise.resolve(execute(input, operation));
          const result = await (mutate ? options.track(pending) : pending);
          if (['scan_inventory', 'stop_task', 'adjust_task', 'confirm_plan'].includes(name)) waitingForExecution = true;
          run.assertCurrent();
          options.emit('tool_result', { callId: context.toolCallId, name, result });
          return result;
        } catch (error) {
          run.assertCurrent();
          if (!(error instanceof TaskError)) { failed = true; throw new TaskError(503, 'tool_storage_or_runtime_failed'); }
          const result = { error: error instanceof TaskError ? error.message : 'operation_failed_query_current_facts' };
          options.emit('tool_result', { callId: context.toolCallId, name, result });
          return result;
        }
      } });
  }
  const tools = {
    explain_waiting: define('explain_waiting', '针对 waitingEvents 中明确事件准备解释或澄清。说明会随最终回复原子发布；用于防止后台重复解释，不能表示业务已解决。',
      { continuationId: string, explanation: string }, ['continuationId', 'explanation'], false,
      input => run.explainWaiting(text(input, 'continuationId'), text(input, 'explanation'))),
    read_state: define('read_state', '读取本会话最新方案、展示、任务、未知及全局占用；进度回答前先读。', {}, [], false,
      () => ({ ...contextFor(business, conversationId, sourceMessage, 48000, run.turn.sourceMessages).facts,
        globalTasks: business.global().tasks.map(t => ({ id: t.id, conversationId: t.conversationId, task: t.task })) })),
    read_history: define('read_history', '本会话历史，返回按时间排列的最近一页，nextBefore 用于读取更早记录。',
      { before: string, query: string }, [], false,
      input => business.records.messagePage(conversationId, { before: input.before as string | undefined, query: input.query as string | undefined })),
    read_task: define('read_task', '读取本会话任务，或全局正在占用设备的明确任务。', { taskId: string }, ['taskId'], false,
      input => task(text(input, 'taskId'), true)),
    read_plan: define('read_plan', '读取本会话历史或当前方案的原始目标、依据和限制；历史授权不能再次使用。', { planId: string }, ['planId'], false,
      input => plan(text(input, 'planId'))),
    find_material: define('find_material', '从有版本资料按名称或 ID 查材料；歧义需澄清，不凭模型记忆编造 ID。', { query: string }, ['query'], false,
      input => {
        const query = text(input, 'query'); const snapshot = business.catalog.snapshot;
        const matches = Object.entries(snapshot.items).filter(([id, item]) => id === query || item.name.includes(query));
        return { version: snapshot.version, sources: snapshot.sources, coverage: snapshot.coverage,
          matches: matches.slice(0, 20).map(([id, item]) => ({ id, ...item })), more: matches.length > 20 };
      }),
    select_stage: define('select_stage', '核对材料与关卡依据；默认推荐不代表最优效率，不保证关卡当前开放或账号可用。',
      { itemId: string, stage: string }, [], false, input => ({ ...business.catalog.select(input.stage as string | undefined, input.itemId as string | undefined),
        version: business.catalog.snapshot.version, sources: business.catalog.snapshot.sources })),
    estimate_plan: define('estimate_plan', '读取有来源的参考消耗与限制，不保证当前理智或材料产量。',
      { stage: string, quantity: { type: 'integer', minimum: 1, maximum: 2147483647 }, itemId: string }, ['stage', 'quantity'], false,
      input => ({ estimate: business.catalog.estimate(text(input, 'stage'), Number(input.quantity), input.itemId as string | undefined),
        version: business.catalog.snapshot.version, sources: business.catalog.snapshot.sources })),
    create_request: define('create_request', '明确执行意图才建立目标；缺项可留草案，所有刷图先展示再确认。咨询不调用。', { goal }, ['goal'], true,
      (input, op) => op.sync(() => ({ targetId: op.id, result: business.createRequest(conversationId, op.id, op.sourceMessage, input.goal) }))),
    revise_request: define('revise_request', '补充或修改当前目标，传完整的新目标草案；修订后等待新的展示和确认。',
      { requestId: string, revision, goal }, ['requestId', 'revision', 'goal'], true,
      (input, op) => { const target = request(text(input, 'requestId')); return op.sync(() => ({ targetId: target.id,
        result: business.reviseRequest(target.id, version(input), op.sourceMessage, input.goal) })); }),
    prepare_plan: define('prepare_plan', '依据当前事实准备方案；不会确认或开始执行。', { requestId: string, revision }, ['requestId', 'revision'], true,
      (input, op) => { const target = request(text(input, 'requestId')); return op.sync(() => ({ targetId: target.id, result: business.prepare(target.id, version(input)) })); }),
    cancel_request: define('cancel_request', '取消尚未开始的需求。执行中的任务须停止，取消模型不等于停止。', { requestId: string, revision }, ['requestId', 'revision'], true,
      (input, op) => { const target = request(text(input, 'requestId')); return op.sync(() => ({ targetId: target.id, result: business.cancelRequest(target.id, version(input)) })); }),
    inspect_inventory: define('inspect_inventory', '仅用户独立要求查看库存时建立新意图，会替换当前需求。不是读取工具！补库存需求禁止用它作前置步骤，应直接 scan_inventory 原 execute 请求；已有事实用 read_state。', {}, [], true,
      (_input, op) => op.sync(() => ({ targetId: op.id, result: business.inspectInventory(conversationId, op.id, op.sourceMessage) }))),
    scan_inventory: define('scan_inventory', '仅明确补库存或查看库存意图可扫描；先保存说明，扫描受理后结束本轮，不循环等待。',
      { requestId: string, revision, explanation: string }, ['requestId', 'revision', 'explanation'], true,
      (input, op) => { const target = request(text(input, 'requestId')); return op.async(associate => business.scan(target.id, version(input), op.id, text(input, 'explanation'), associate)); }),
    confirm_plan: define('confirm_plan', '仅本条用户消息明确确认已展示的当前方案时开始。修改与开始不能借同一消息授权新方案。',
      { planId: string, presentationId: string }, ['planId', 'presentationId'], true,
      (input, op) => { const target = plan(text(input, 'planId')); return op.async(associate => business.confirm(target.id, text(input, 'presentationId'), op.id, 'message', sourceMessage, associate)); }),
    reuse_plan: define('reuse_plan', '用户明确要求再次采用历史方案时形成新需求；重查依据、展示并重新确认。', { planId: string }, ['planId'], true,
      (input, op) => { const target = plan(text(input, 'planId')); return op.sync(() => ({ targetId: op.id, result: business.reusePlan(target.id, conversationId, op.id, op.sourceMessage) })); }),
    stop_task: define('stop_task', '用户明确停止或调整执行中的任务时先停止。含糊调整也先停止，再澄清总共或新增；假设咨询不停止。', { taskId: string }, ['taskId'], true,
      (input, op) => { const target = task(text(input, 'taskId'), true); return op.async(associate => business.stop(target.id, associate)); }),
    adjust_task: define('adjust_task', '执行中明确调整时调用，工具内部先停止再建立与原任务关联的新目标。total 是总目标，additional 是再获得；不得猜测。不必先单独 stop_task；受理后结束本轮。',
      { taskId: string, goal, semantics: { type: 'string', enum: ['total', 'additional'] } }, ['taskId', 'goal', 'semantics'], true,
      async (input, op) => { const target = task(text(input, 'taskId')); if (!['total', 'additional'].includes(String(input.semantics))) throw new TaskError(422, 'invalid_adjustment');
        try {
          // Valid adjustments reserve stop and associate the replacement in one transaction.
          return await op.async(associate => business.adjust(target.id, op.id, op.sourceMessage, input.goal, input.semantics as 'total' | 'additional', associate));
        } catch (error) {
          if (!(error instanceof TaskError) || error.message !== 'incomparable_total_goal') throw error;
          // A rejected incomparable target still expresses stop intent. Persist that
          // stop with its own result under this operation, without a replacement request.
          return op.async(async associate => ({ error: 'incomparable_total_goal', stop: await business.stop(target.id, associate) }));
        } }),
    record_inventory_change: define('record_inventory_change', '仅记录用户明确报告的外部库存变化；不知道材料范围时传 null，不猜数量。',
      { itemIds: { type: ['array', 'null'], items: string, maxItems: 100 }, reason: string }, ['itemIds', 'reason'], true,
      (input, op) => op.sync(() => ({ targetId: op.id, result: business.recordInventoryChange(op.id,
        input.itemIds as string[] | null, `${op.sourceMessage}: ${text(input, 'reason')}`, conversationId) }))),
  };
  return { tools: options.readOnly ? Object.fromEntries(Object.entries(tools).filter(([name]) =>
    ['read_state', 'read_history', 'read_task', 'read_plan', 'find_material', 'select_stage', 'estimate_plan', 'explain_waiting'].includes(name))) : tools,
    nextStep: () => { check(); stepMutated = false; }, calls: () => calls, waiting: () => waitingForExecution };
}

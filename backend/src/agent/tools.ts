import { isDeepStrictEqual } from 'node:util';
import { tool, jsonSchema } from 'ai';
import { submission, MAX_COUNT, TaskError } from '../task-contract.ts';
import type { Params } from '../task-contract.ts';
import type { TaskService } from '../task-service.ts';
import type { AgentRecords, EventSink, RequestRecord } from './records.ts';

export function boundTools(context: {
  record: RequestRecord; records: AgentRecords; tasks: TaskService; signal: AbortSignal;
  emit: EventSink; isOpen: () => boolean;
}) {
  const { record, records, tasks, signal, emit, isOpen } = context;
  let mutation: Promise<unknown> | undefined;
  function checkOpen() {
    signal.throwIfAborted();
    if (!isOpen()) throw new Error('request_closed');
  }
  async function execute(name: string, input: unknown) {
    try {
      checkOpen();
      await emit({ kind: 'tool_call', data: { name, input } });
      checkOpen();
      const permission = record.permission;
      if (name === 'submit_task') {
        const valid = submission({ id: record.operationId, params: input });
        if (permission.action !== 'submit' || !isDeepStrictEqual(valid.params, permission.params)) {
          throw new Error('parameters_not_authorized');
        }
      } else {
        if (!isDeepStrictEqual(input, {})) throw new Error('unexpected_parameters');
        if (permission.action !== (name === 'get_task' ? 'get' : 'stop')) throw new Error('operation_not_authorized');
      }
      if (name === 'get_task' && permission.action === 'get') return tasks.get(permission.targetId);
      if (record.mutation) {
        if (record.mutation.tool !== name || !isDeepStrictEqual(record.mutation.input, input)) throw new Error('mutation_conflict');
        return mutation ?? { error: 'previous_attempt_not_replayed', operationId: record.operationId };
      }
      // 同步持久预留；同一步并行 Tool Call 也只能取得一次变更资格。
      record.mutation = { tool: name, input };
      record.summary = name === 'submit_task' && permission.action === 'submit'
        ? `执行 1-7 ${permission.params.count} 次，不吃药、不碎石。任务 ID：${record.operationId}`
        : `请求停止任务 ${permission.action === 'stop' ? permission.targetId : ''}；停止确认以执行证据为准。`;
      records.save(record);
      mutation = (async () => {
        await emit({ kind: 'summary', data: record.summary });
        checkOpen();
        // 从最后一次检查到服务同步预留之间没有 await。
        return name === 'submit_task' && permission.action === 'submit'
          ? tasks.submit({ id: record.operationId, params: permission.params })
          : tasks.stop(permission.action === 'stop' ? permission.targetId : '');
      })();
      return await mutation;
    } catch (error) {
      // 不向模型返回 provider 异常、凭据或堆栈。
      return { error: error instanceof TaskError ? error.message :
        error instanceof Error && ['parameters_not_authorized', 'operation_not_authorized', 'unexpected_parameters', 'mutation_conflict'].includes(error.message)
          ? error.message : 'operation_failed_or_cancelled', operationId: record.operationId };
    }
  }
  const empty = jsonSchema<Record<string, never>>({ type: 'object', properties: {}, additionalProperties: false });
  function wrapped(name: string) {
    return async (input: unknown) => {
      const result = await execute(name, input);
      await emit({ kind: 'tool_result', data: { name, result } });
      return result;
    };
  }
  return {
    submit_task: tool({ description: '提交本轮完整明确指令指定的 1-7 任务，不修改用户参数。',
      inputSchema: jsonSchema<Params>({ type: 'object', additionalProperties: false,
        properties: { stage: { type: 'string', enum: ['1-7'] }, count: { type: 'integer', minimum: 1, maximum: MAX_COUNT },
          medicine: { type: 'integer', enum: [0] }, premium: { type: 'integer', enum: [0] } },
        required: ['stage', 'count', 'medicine', 'premium'] }), execute: wrapped('submit_task') }),
    get_task: tool({ description: '查询应用已选定的任务，不接受模型提供任务 ID。', inputSchema: empty, execute: wrapped('get_task') }),
    stop_task: tool({ description: '按本轮明确停止指令请求停止已选定任务，受理不等于停止确认。', inputSchema: empty, execute: wrapped('stop_task') }),
  };
}

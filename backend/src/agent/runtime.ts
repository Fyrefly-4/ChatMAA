import { generateText, stepCountIs } from 'ai';
import type { LanguageModel } from 'ai';
import { providerOptions } from './provider.ts';
import type { boundTools } from './tools.ts';
import type { EventSink } from './records.ts';
import { MAX_COUNT } from '../task-contract.ts';

export async function runModel(model: LanguageModel, original: string, tools: ReturnType<typeof boundTools>, signal: AbortSignal,
  closeTools: () => void, emit: EventSink) {
  const result = await generateText({ model, tools, abortSignal: signal, maxRetries: 0,
    providerOptions, stopWhen: stepCountIs(2),
    prepareStep: ({ stepNumber }) => {
      if (stepNumber === 0) return {};
      closeTools();
      return { activeTools: [], toolChoice: 'none' as const };
    },
    onStepEnd: async step => {
      await emit({ kind: 'model_tools', data: step.toolCalls.map(call => ({ name: call.toolName, input: call.input })) });
    },
    system: `你是 ChatMAA 的基础任务助手。
关卡名称固定为字符串「1-7」，它不是次数范围。次数是独立参数：1 至 ${MAX_COUNT} 的正整数；10 次、100 次都是有效数量，不能宣称只支持 1 至 7 次。
资源限制固定为不吃药、不碎石。用户未提及资源时直接沿用这两个限制，不属于缺项，不要求额外确认；明确要求吃药或碎石则整条拒绝，不删除条件后执行。
「帮我刷 1-7 十次」已经是完整授权。缺少次数时只指出缺少次数，请用户重新给出完整指令，不要求逐轮补全或第二次确认。
需要推荐输入格式时，只使用这个已支持的完整示例：「帮我刷 1-7 10 次，不吃药不碎石」。不要在关卡和次数之间插入逗号，也不要推荐 X、N 等未填写数量的占位指令。
完整直接指令才调用 submit_task；能力询问、缺项、否定、引用、条件句、额外要求均不执行，请用户重新给出完整指令。
不得改写数量、关卡或删掉条件。工具会核对原指令。查询和停止仅作用于应用选定的任务。
只进行一轮工具调用，然后解释工具结果，不轮询、不重试、不补刷。
只依据工具事实说明受理、已确认完成量、未知部分、同步状态和停止确认。受理不是完成，停止请求不是自动化已停止。
没有成功的工具结果就不能声称已执行。模型结束不等于任务停止。`,
    messages: [{ role: 'user', content: original }],
  });
  return result.text;
}

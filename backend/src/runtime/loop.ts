import { generateText, stepCountIs } from 'ai';
import type { LanguageModel } from 'ai';
import type { BusinessService } from '../business/service.ts';
import { providerOptions } from '../agent/provider.ts';
import { TaskError } from '../task-contract.ts';
import { businessTools } from './tools.ts';
import { RuntimeRecords } from './records.ts';
import type { RunTurn } from './service.ts';
import { instructions, INSTRUCTIONS_VERSION } from './instructions.ts';

export function modelRunner(business: BusinessService, model: LanguageModel, readOnly = false): RunTurn {
  const records = new RuntimeRecords(business.tasks.store);
  return async run => {
    const emit = (kind: string, data: unknown) => { run.assertCurrent(); records.activity(run.turn.id, kind, data); };
    const restricted = readOnly || !!run.turn.continuationId;
    const bound = businessTools(business, run, { emit, track: run.track, readOnly: restricted });
    emit('model_started', { instructionsVersion: INSTRUCTIONS_VERSION, readOnly: restricted,
      model: typeof model === 'string' ? model : model.modelId, provider: typeof model === 'string' ? null : model.provider });
    const result = await generateText({ model, tools: bound.tools, system: instructions,
      messages: [{ role: 'user', content: JSON.stringify(run.context) }], abortSignal: run.signal,
      providerOptions, maxRetries: 0, maxOutputTokens: 6000, stopWhen: stepCountIs(8),
      prepareStep: ({ stepNumber, messages }) => {
        run.assertCurrent(); bound.nextStep();
        if (JSON.stringify(messages).length + instructions.length > 48000) throw new TaskError(422, 'context_budget_exceeded');
        return stepNumber >= 7 || bound.calls() >= 12 || bound.waiting() ? {
          activeTools: [], toolChoice: 'none' as const,
          system: `${instructions}\n宿主通知：本轮工具阶段已经结束，不能再调用任何工具。请直接用普通中文向用户解释已返回的结果、仍待确认的状态和下一步。不要输出工具调用、DSML 或模拟工具协议，也不要等待更多状态。`,
        } : {};
      },
      onStepEnd: step => { emit('model_step', { toolCalls: step.toolCalls.length, finishReason: step.finishReason, usage: step.usage }); },
    });
    run.assertCurrent();
    if (result.finishReason === 'length') throw new TaskError(422, 'model_output_budget_exceeded');
    if (!result.text.trim()) throw new TaskError(422, 'model_empty_response');
    if (/<[|｜]+DSML[|｜]+/i.test(result.text)) throw new TaskError(422, 'model_invalid_response');
    return result.text.trim();
  };
}

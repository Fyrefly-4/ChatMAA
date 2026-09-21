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
    const bound = businessTools(business, run, { emit, track: run.track, readOnly });
    emit('model_started', { instructionsVersion: INSTRUCTIONS_VERSION, readOnly });
    const result = await generateText({ model, tools: bound.tools, system: instructions,
      messages: [{ role: 'user', content: JSON.stringify(run.context) }], abortSignal: run.signal,
      providerOptions, maxRetries: 0, stopWhen: stepCountIs(8),
      prepareStep: ({ stepNumber, messages }) => {
        run.assertCurrent(); bound.nextStep();
        if (JSON.stringify(messages).length + instructions.length > 48000) throw new TaskError(422, 'context_budget_exceeded');
        return stepNumber >= 7 || bound.calls() >= 12 ? { activeTools: [], toolChoice: 'none' as const } : {};
      },
      onStepEnd: step => { emit('model_step', { toolCalls: step.toolCalls.length, finishReason: step.finishReason }); },
    });
    run.assertCurrent();
    return result.text.trim() || '本轮未生成完整解释。请查看当前方案与任务事实；已受理的任务不会因本轮结束而撤销，必要时使用直接停止入口。';
  };
}

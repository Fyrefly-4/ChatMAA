import type { BusinessService } from '../business/service.ts';
import type { Turn } from './records.ts';
import { RuntimeOperations } from './operations.ts';

export function failureHandoff(business: BusinessService, turn: Turn, reason: string) {
  const conversation = business.records.read('conversations', turn.conversationId)!;
  const operations = new RuntimeOperations(business.tasks.store).forSources(turn.conversationId, turn.sourceMessages ?? [turn.sourceMessage]);
  const plan = conversation.currentPlan ? business.plan(conversation.currentPlan) : null;
  const request = conversation.currentRequest ? business.request(conversation.currentRequest) : null;
  const guidance = request ? business.waitingGuidance(request.id) : null;
  const text = ['本轮回复未完成，已有业务记录已保留。',
    operations.length ? '请查看当前方案和任务；已登记操作不会自动重发，执行状态以任务记录为准。' : '本轮未登记业务操作；可以补充或重新提出需求。',
    plan ? (plan.taskId ? '方案已有任务，请查看任务进度；需要时可直接停止。' :
      ['unpresented', 'presented'].includes(plan.state) ? '当前方案仍需阅读并确认，尚未因此开始刷图。' : '当前方案依据已变化，请查看方案状态并补充说明。') : '',
    guidance?.message ?? '', `原因：${reason}。`].filter(Boolean).join('\n');
  business.appendMessage(turn.conversationId, `handoff-${turn.id}`, 'system', text, plan?.taskId ?? plan?.id ?? turn.id);
  return { reason, requestId: request?.id ?? null, planId: plan?.id ?? null, operations: operations.map(op => op.id) };
}

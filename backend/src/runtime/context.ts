import type { BusinessService } from '../business/service.ts';
import type { Message } from '../business/records.ts';
import { TaskError } from '../task-contract.ts';
import { RuntimeOperations } from './operations.ts';

// Historical system messages are business data, never privileged model instructions.
export function contextFor(business: BusinessService, conversationId: string, sourceMessage: string, maxCharacters = 48000, sourceMessages = [sourceMessage]) {
  const records = business.records;
  const conversation = records.read('conversations', conversationId);
  if (!conversation) throw new TaskError(404, 'unknown_conversation');
  const source = records.read('messages', sourceMessage);
  if (!source || source.conversationId !== conversationId || source.role !== 'user') throw new TaskError(422, 'user_message_required');
  const request = conversation.currentRequest ? business.request(conversation.currentRequest) : null;
  const plan = conversation.currentPlan ? business.plan(conversation.currentPlan) : null;
  const anchors = new Map<string, Message>();
  for (const id of [request?.sourceMessage, ...sourceMessages, sourceMessage]) {
    if (!id) continue;
    const message = records.read('messages', id);
    if (message?.conversationId === conversationId) anchors.set(message.id, message);
  }
  const recent = records.messagePage(conversationId, { limit: 12 });
  const messages = recent.messages.filter(message => !anchors.has(message.id));
  const presentation = plan ? records.latestPresentation(plan.id) : null;
  const taskIds = new Set([request?.scanTask, ...(request?.previousTasks ?? []), plan?.taskId].filter((id): id is string => !!id));
  const facts = { conversation, request, plan, presentation,
    waitingEvents: records.list('continuations', conversationId).filter(event => event.requestId === request?.id &&
      event.revision === request.revision && !['completed', 'obsolete'].includes(event.state))
      .map(({ id, requestId, revision, reason, taskId, state }) => ({ id, requestId, revision, reason, taskId, state })),
    tasks: [...taskIds].map(id => business.task(id)), catalogVersion: business.catalog.snapshot.version,
    admission: business.tasks.admission(), projection: business.global().projection };
  const input = { facts, anchors: [...anchors.values()], messages, historyBefore: recent.nextBefore,
    pendingSources: sourceMessages, operations: new RuntimeOperations(business.tasks.store).forSources(conversationId, sourceMessages),
    budget: { approximate: true, characters: maxCharacters } };
  // Trim optional history only. Never silently discard the current instruction or goal source.
  while (JSON.stringify(input).length > maxCharacters && messages.length) messages.shift();
  if (JSON.stringify(input).length > maxCharacters) throw new TaskError(422, 'context_budget_exceeded');
  return input;
}

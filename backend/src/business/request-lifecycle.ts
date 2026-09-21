import { TaskError } from '../task-contract.ts';
import type { GoalDraft } from './goals.ts';
import type { Request } from './records.ts';

type Transition =
  | { type: 'inspect' }
  | { type: 'revise'; goal: GoalDraft; sourceMessage: string }
  | { type: 'wait'; reasons: string[] }
  | { type: 'scan_started'; taskId: string }
  | { type: 'scan_observed'; taskId: string }
  | { type: 'adjust'; previousTasks: string[]; semantics: 'total' | 'additional'; observedId: string | null }
  | { type: 'supersede' | 'cancel' | 'execute' | 'complete' };

export function newRequest(id: string, conversationId: string, sourceMessage: string, goal: GoalDraft): Request {
  return { id, conversationId, sourceMessage, goal, revision: 1, state: 'active', intent: 'execute',
    waiting: [], scanTask: null, scanRevision: null, previousTasks: [], adjustment: null, observedId: null };
}
export function canRevise(request: Request) {
  return request.state === 'active' || (request.state === 'completed' && request.intent === 'inspect_inventory');
}
export function awaitsScan(request: Request, taskId: string) {
  return request.state === 'active' && request.revision === request.scanRevision &&
    request.scanTask === taskId && request.waiting.includes('scan_pending');
}

// One place owns coupled intent/state/version/scan changes. No I/O or execution.
export function transitionRequest(request: Request, event: Transition): Request {
  const invalid = (): never => { throw new TaskError(409, 'invalid_request_transition'); };
  if (event.type === 'revise') {
    if (!canRevise(request)) return invalid();
    const reuseScan = request.goal.kind === 'inventory' && event.goal.kind === 'inventory' && request.scanTask !== null;
    return { ...request, goal: event.goal, sourceMessage: event.sourceMessage, intent: 'execute',
      state: 'active', revision: request.revision + 1, waiting: [],
      scanTask: reuseScan ? request.scanTask : null, scanRevision: reuseScan ? request.revision + 1 : null,
      observedId: event.goal.kind === 'inventory' ? request.observedId : null };
  }
  if (event.type === 'complete') {
    if (!['active', 'executing'].includes(request.state)) return invalid();
    return { ...request, state: 'completed', waiting: [] };
  }
  if (request.state !== 'active') return invalid();
  switch (event.type) {
    case 'inspect':
      if (request.goal.kind !== 'inventory' || request.goal.quantity !== undefined) return invalid();
      return { ...request, intent: 'inspect_inventory', waiting: ['inventory_required'] };
    case 'wait': return { ...request, waiting: event.reasons };
    case 'scan_started':
      if (request.goal.kind !== 'inventory') return invalid();
      return { ...request, scanTask: event.taskId, scanRevision: request.revision, observedId: null, waiting: ['scan_pending'] };
    case 'scan_observed':
      if (!awaitsScan(request, event.taskId)) return invalid();
      return { ...request, observedId: event.taskId, waiting: [],
        state: request.intent === 'inspect_inventory' ? 'completed' : 'active' };
    case 'adjust': return { ...request, intent: 'execute', previousTasks: [...new Set(event.previousTasks)],
      adjustment: event.semantics, observedId: event.observedId, waiting: ['stop_or_environment_unconfirmed'] };
    case 'supersede': return { ...request, state: 'superseded', waiting: [] };
    case 'cancel': return { ...request, state: 'cancelled', waiting: [] };
    case 'execute':
      if (request.intent !== 'execute') return invalid();
      return { ...request, state: 'executing', waiting: [] };
  }
}

import type { FastifyInstance } from 'fastify';
import { TaskError } from '../task-contract.ts';
import type { BusinessService } from './service.ts';

// The same deterministic operations are available to in-process Runtime callers.
// This route is an application-token debugging surface, not an LLM/Core parameter tunnel.
export function businessRoutes(app: FastifyInstance, business: BusinessService) {
  app.get('/business/status', async () => ({ ...business.global(), device: await business.tasks.device().catch(() => null) }));
  app.get('/business/catalog', async () => business.catalog.snapshot);
  app.get<{ Params: { id: string } }>('/business/conversations/:id', async r => business.conversation(r.params.id));
  app.get<{ Params: { id: string } }>('/business/tasks/:id', async r => business.task(r.params.id));
  app.post('/business/operations', async (request, reply) => {
    reply.code(200);
    return await businessOperation(business, request.body);
  });
}
export async function businessOperation(b: BusinessService, value: unknown): Promise<unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TaskError(422, 'invalid_operation');
  const v = value as Record<string, unknown>;
  const fields: Record<string, string[]> = {
    create_conversation: ['id', 'title'], append_message: ['conversationId', 'id', 'role', 'text'],
    create_request: ['conversationId', 'id', 'sourceMessage', 'goal'],
    inspect_inventory: ['conversationId', 'id', 'sourceMessage'],
    revise_request: ['id', 'revision', 'sourceMessage', 'goal'], cancel_request: ['id', 'revision'],
    prepare: ['id', 'revision'], present_plan: ['planId', 'id'],
    confirm_plan: ['planId', 'presentationId', 'id', 'source', 'sourceMessage?'],
    scan_inventory: ['requestId', 'revision', 'id', 'explanation'],
    stop_task: ['id'], adjust_task: ['taskId', 'requestId', 'sourceMessage', 'goal', 'semantics'],
    reuse_plan: ['planId', 'conversationId', 'requestId', 'sourceMessage'],
    inventory_changed: ['id', 'itemIds', 'reason', 'conversationId?'],
    recheck: ['taskId', 'id'], takeover: ['id', 'confirmed', 'targets'],
    activate_catalog: ['snapshot'],
  };
  const operation = typeof v.operation === 'string' ? v.operation : '';
  const allowed = fields[operation];
  if (!allowed || Object.keys(v).some(k => k !== 'operation' && !allowed.map(f => f.replace('?', '')).includes(k)) ||
      allowed.some(k => !k.endsWith('?') && !Object.hasOwn(v, k))) throw new TaskError(422, 'invalid_operation');
  function text(key: string): string {
    if (typeof v[key] !== 'string') throw new TaskError(422, 'invalid_operation'); return v[key] as string;
  }
  function revision() {
    if (!Number.isSafeInteger(v.revision) || Number(v.revision) < 1) throw new TaskError(422, 'invalid_revision'); return Number(v.revision);
  }
  switch (operation) {
    case 'create_conversation': return b.createConversation(text('id'), text('title'));
    case 'append_message': return b.appendMessage(text('conversationId'), text('id'), text('role') as 'user' | 'assistant' | 'system', text('text'));
    case 'create_request': return b.createRequest(text('conversationId'), text('id'), text('sourceMessage'), v.goal);
    case 'inspect_inventory': return b.inspectInventory(text('conversationId'), text('id'), text('sourceMessage'));
    case 'revise_request': return b.reviseRequest(text('id'), revision(), text('sourceMessage'), v.goal);
    case 'cancel_request': return b.cancelRequest(text('id'), revision());
    case 'prepare': return b.prepare(text('id'), revision());
    case 'present_plan': return b.present(text('planId'), text('id'));
    case 'confirm_plan': return b.confirm(text('planId'), text('presentationId'), text('id'), text('source') as 'button' | 'message',
      v.sourceMessage === undefined ? undefined : text('sourceMessage'));
    case 'scan_inventory': return b.scan(text('requestId'), revision(), text('id'), text('explanation'));
    case 'stop_task': return b.stop(text('id'));
    case 'adjust_task': return b.adjust(text('taskId'), text('requestId'), text('sourceMessage'), v.goal, text('semantics') as 'total' | 'additional');
    case 'reuse_plan': return b.reusePlan(text('planId'), text('conversationId'), text('requestId'), text('sourceMessage'));
    case 'inventory_changed': return b.recordInventoryChange(text('id'), v.itemIds as string[] | null, text('reason'),
      v.conversationId === undefined ? '' : text('conversationId'));
    case 'recheck': return b.tasks.recheck(text('taskId'), { id: text('id') });
    case 'takeover': return b.tasks.takeover({ id: text('id'), confirmed: v.confirmed, targets: v.targets });
    case 'activate_catalog': return b.activateCatalog(v.snapshot);
  }
}

import type { FastifyInstance } from 'fastify';
import type { BusinessService } from '../business/service.ts';
import type { RuntimeService } from '../runtime/service.ts';
import { TaskError } from '../task-contract.ts';
import { MvpQueries, pageNumber } from './mvp-queries.ts';

function fields(body: unknown, keys: string[]): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(k => !keys.includes(k)) || keys.some(k => !Object.hasOwn(body, k)))
    throw new TaskError(422, 'invalid_operation');
  return body as Record<string, unknown>;
}
function text(body: Record<string, unknown>, key: string) {
  if (typeof body[key] !== 'string') throw new TaskError(422, 'invalid_operation');
  return body[key] as string;
}
export async function mvpStatus(b: BusinessService, runtime: RuntimeService) {
  const global = b.global(); const q = new MvpQueries(b, runtime);
  return { entry: 'mvp-runtime' as const, mode: b.tasks.source, ...global, tasks: global.tasks.map(t => q.task(t.id)), runtime: runtime.status(),
    closing: b.tasks.closing, adapterAvailable: !b.tasks.exited, storageFailed: b.tasks.storageFailed,
    device: await b.tasks.device().catch(() => null) };
}
export type MvpStatus = Awaited<ReturnType<typeof mvpStatus>>;

export function mvpRoutes(app: FastifyInstance, b: BusinessService, runtime: RuntimeService) {
  const q = new MvpQueries(b, runtime);
  app.get('/api/status', () => mvpStatus(b, runtime));
  app.post('/api/conversations', request => {
    const v = fields(request.body, ['id', 'title']); return b.createConversation(text(v, 'id'), text(v, 'title'));
  });
  app.get<{ Params: { id: string } }>('/api/conversations/:id', r => q.conversation(r.params.id));
  app.get<{ Params: { id: string }; Querystring: { before?: string; after?: string } }>('/api/conversations/:id/messages', r =>
    q.messages(r.params.id, r.query.before, r.query.after));
  app.get<{ Params: { id: string; message: string } }>('/api/conversations/:id/messages/:message', r => q.message(r.params.id, r.params.message));
  app.get<{ Params: { id: string }; Querystring: { before?: string; after?: string } }>('/api/conversations/:id/turns', r =>
    q.turns(r.params.id, r.query.before === undefined ? undefined : pageNumber(r.query.before),
      r.query.after === undefined ? undefined : pageNumber(r.query.after)));
  app.post('/api/messages', (r, reply) => {
    const v = fields(r.body, ['conversationId', 'messageId', 'text']);
    return reply.code(202).send(runtime.submit(text(v, 'conversationId'), text(v, 'messageId'), text(v, 'text')));
  });
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/api/turns/:id', r => runtime.read(r.params.id, pageNumber(r.query.after)));
  app.get<{ Params: { id: string } }>('/api/plans/:id', r => q.plan(r.params.id));
  app.post<{ Params: { id: string } }>('/api/plans/:id/present', r => {
    const v = fields(r.body, ['id']); return b.present(r.params.id, text(v, 'id'));
  });
  app.post<{ Params: { id: string } }>('/api/plans/:id/confirm', async r => {
    const v = fields(r.body, ['id', 'presentationId']);
    const result = await b.confirm(r.params.id, text(v, 'presentationId'), text(v, 'id'), 'button');
    return q.task(result.id);
  });
  app.post<{ Params: { id: string } }>('/api/requests/:id/cancel', r => {
    const v = fields(r.body, ['revision']);
    if (!Number.isSafeInteger(v.revision) || Number(v.revision) < 1) throw new TaskError(422, 'invalid_revision');
    return b.cancelRequest(r.params.id, Number(v.revision));
  });
  app.get<{ Params: { id: string } }>('/api/tasks/:id', r => q.task(r.params.id));
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/api/tasks/:id/events', r => q.evidence(r.params.id, pageNumber(r.query.after)));
  app.post<{ Params: { id: string } }>('/api/tasks/:id/stop', async (r, reply) => {
    fields(r.body, []); return reply.code(202).send(await b.stop(r.params.id));
  });
  app.post<{ Params: { id: string } }>('/api/tasks/:id/recheck', async (r, reply) => {
    const v = fields(r.body, ['id']); return reply.code(202).send(await b.tasks.recheck(r.params.id, { id: text(v, 'id') }));
  });
  app.post('/api/takeovers', async (r, reply) => {
    const v = fields(r.body, ['id', 'confirmed', 'targets']);
    return reply.code(202).send(await b.tasks.takeover(v));
  });
}

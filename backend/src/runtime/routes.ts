import type { FastifyInstance } from 'fastify';
import { TaskError } from '../task-contract.ts';
import type { RuntimeService } from './service.ts';

// Application-token surface only; D5 supplies its own browser identity wrapper.
export function runtimeRoutes(app: FastifyInstance, runtime: RuntimeService) {
  app.get('/runtime/status', async () => runtime.status());
  app.post('/runtime/messages', async (request, reply) => {
    const value = request.body as Record<string, unknown> | null;
    if (!value || Array.isArray(value) || Object.keys(value).some(k => !['conversationId', 'messageId', 'text'].includes(k)) ||
        !['conversationId', 'messageId', 'text'].every(k => typeof value[k] === 'string')) throw new TaskError(422, 'invalid_message');
    return reply.code(202).send(runtime.submit(value.conversationId as string, value.messageId as string, value.text as string));
  });
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/runtime/turns/:id', async request =>
    runtime.read(request.params.id, request.query.after === undefined ? 0 : Number(request.query.after)));
  app.get<{ Params: { id: string } }>('/runtime/conversations/:id', async request => runtime.conversation(request.params.id));
}

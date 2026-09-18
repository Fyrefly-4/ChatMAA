import Fastify from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { TaskError } from './task-contract.ts';
import type { TaskService } from './task-service.ts';

export function createApp(tasks: TaskService, token: string, shutdown: () => void) {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (request, reply) => {
    const provided = request.headers['x-app-token'];
    if (request.headers.origin || typeof provided !== 'string' || Buffer.byteLength(provided) !== Buffer.byteLength(token) ||
        !timingSafeEqual(Buffer.from(provided), Buffer.from(token))) return reply.code(403).send({ error: 'unauthorized' });
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof TaskError) return reply.code(error.status).send({ error: error.message });
    if (error instanceof Error && 'statusCode' in error && error.statusCode === 400) return reply.code(400).send({ error: 'invalid_json' });
    return reply.code(503).send({ error: 'service_unavailable' });
  });
  app.get('/health', async () => ({ mode: tasks.source, closing: tasks.closing, adapter_available: !tasks.exited, storage_failed: tasks.storageFailed }));
  app.get('/tasks', async () => tasks.list());
  app.post('/tasks', async (request, reply) => reply.code(202).send(await tasks.submit(request.body)));
  app.get<{ Params: { id: string } }>('/tasks/:id', async request => tasks.get(request.params.id));
  app.post<{ Params: { id: string } }>('/tasks/:id/stop', async (request, reply) => reply.code(202).send(await tasks.stop(request.params.id)));
  app.post('/shutdown', async (_request, reply) => {
    reply.code(202).send({ shutting_down: true });
    setTimeout(shutdown, 10);
  });
  return app;
}

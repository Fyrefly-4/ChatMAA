import type { FastifyInstance } from 'fastify';
import type { TaskService } from '../task-service.ts';
import type { BrowserRequests } from './requests.ts';
import { blocksExecution } from '../task-contract.ts';

export function browserRoutes(app: FastifyInstance, tasks: TaskService, requests: BrowserRequests) {
  app.get('/api/status', async () => ({ mode: tasks.source, modelAvailable: requests.modelAvailable,
    closing: tasks.closing || requests.closing, busy: requests.busy,
    adapterAvailable: !tasks.exited, storageFailed: tasks.storageFailed,
    device: await tasks.device().catch(() => null),
    conflictingTaskIds: tasks.list().filter(blocksExecution).map(t => t.id) }));
  app.post('/api/takeovers', async (request, reply) => reply.code(202).send(await tasks.takeover(request.body)));
  app.post('/api/requests', async (request, reply) => reply.code(202).send(requests.submit(request.body)));
  app.get<{ Params: { id: string } }>('/api/requests/:id', async request => requests.read(request.params.id));
  app.post<{ Params: { id: string } }>('/api/requests/:id/summary-displayed', async request =>
    requests.acknowledge(request.params.id, request.body));
  app.get<{ Params: { id: string } }>('/api/tasks/:id', async request => tasks.get(request.params.id));
  app.post<{ Params: { id: string } }>('/api/tasks/:id/stop', async (request, reply) =>
    reply.code(202).send(await tasks.stop(request.params.id)));
}

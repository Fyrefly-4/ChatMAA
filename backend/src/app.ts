import Fastify from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { TaskError } from './task-contract.ts';
import type { TaskService } from './task-service.ts';
import fastifyStatic from '@fastify/static';
import type { BrowserRequests } from './browser/requests.ts';
import { browserRoutes } from './browser/routes.ts';

export type BrowserOptions = { requests: BrowserRequests; token: string; staticRoot: string;
  origin: () => string; developmentOrigin?: string };
function equal(provided: unknown, token: string) {
  return typeof provided === 'string' && Buffer.byteLength(provided) === Buffer.byteLength(token) &&
    timingSafeEqual(Buffer.from(provided), Buffer.from(token));
}
export function createApp(tasks: TaskService, token: string, shutdown: () => void, browser?: BrowserOptions) {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];
    const browserApi = path === '/api' || path.startsWith('/api/');
    const staticFile = path === '/' || path === '/index.html' || path.startsWith('/assets/');
    if (browser && (browserApi || staticFile)) {
      const origin = browser.origin();
      if (!origin || request.headers.host !== new URL(origin).host ||
          (request.headers.origin !== undefined && request.headers.origin !== origin &&
            request.headers.origin !== browser.developmentOrigin) ||
          (browserApi && !equal(request.headers['x-web-token'], browser.token))) {
        return reply.code(403).send({ error: 'unauthorized' });
      }
      reply.header('Cache-Control', 'no-store');
      reply.header('Referrer-Policy', 'no-referrer');
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      return;
    }
    const provided = request.headers['x-app-token'];
    if (request.headers.origin || !equal(provided, token)) return reply.code(403).send({ error: 'unauthorized' });
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof TaskError) return reply.code(error.status).send({ error: error.message });
    if (error instanceof Error && 'statusCode' in error && error.statusCode === 400) return reply.code(400).send({ error: 'invalid_json' });
    return reply.code(503).send({ error: 'service_unavailable' });
  });
  app.get('/health', async () => ({ mode: tasks.source, closing: tasks.closing, adapter_available: !tasks.exited, storage_failed: tasks.storageFailed }));
  app.get('/tasks', async () => tasks.list());
  app.get('/device', async () => tasks.device());
  app.post('/takeovers', async (request, reply) => reply.code(202).send(await tasks.takeover(request.body)));
  app.post('/tasks', async (request, reply) => reply.code(202).send(await tasks.submit(request.body)));
  app.get<{ Params: { id: string } }>('/tasks/:id', async request => tasks.get(request.params.id));
  app.post<{ Params: { id: string } }>('/tasks/:id/stop', async (request, reply) => reply.code(202).send(await tasks.stop(request.params.id)));
  app.post<{ Params: { id: string } }>('/tasks/:id/recheck', async (request, reply) => reply.code(202).send(await tasks.recheck(request.params.id, request.body)));
  app.post('/shutdown', async (_request, reply) => {
    reply.code(202).send({ shutting_down: true });
    setTimeout(shutdown, 10);
  });
  if (browser) {
    browserRoutes(app, tasks, browser.requests);
    // Only build output is reachable; there is no source-directory SPA fallback.
    app.register(fastifyStatic, { root: browser.staticRoot, serve: false });
    app.get('/', async (_request, reply) => reply.sendFile('index.html'));
    app.get('/index.html', async (_request, reply) => reply.sendFile('index.html'));
    app.get<{ Params: { '*': string } }>('/assets/*', async (request, reply) =>
      reply.sendFile(request.params['*'], `${browser.staticRoot}/assets`));
  }
  return app;
}

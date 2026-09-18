import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { AgentRequests } from './requests.ts';
import type { TaskService } from '../task-service.ts';
import type { LanguageModel } from 'ai';
import type { Readable, Writable } from 'node:stream';
import { waitForOutput } from './wait.ts';

export function startDebug(tasks: TaskService, model: LanguageModel, shutdown: () => Promise<void>,
  options: { input?: Readable; output?: Writable; timeoutMs?: number } = {}) {
  const agent = new AgentRequests(tasks, model);
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const timeoutMs = options.timeoutMs ?? 60000;
  const lines = createInterface({ input });
  const write = (value: unknown, signal = AbortSignal.timeout(timeoutMs)) => waitForOutput(() => new Promise<void>((ok, fail) => {
    output.write(`${JSON.stringify(value)}\n`, error => error ? fail(error) : ok());
  }), signal);
  let targetId: string | undefined;
  let busy = false;
  let active: AbortController | undefined;
  let requestWork: Promise<unknown> | undefined;
  void write({ kind: 'debug_ready', message: '这是常驻 Backend 控制台；关闭它将关闭后端。普通文本发送模型；/target ID 选定任务；/get ID、/stop ID 独立控制；/read REQUEST_ID 读记录；/cancel 取消模型；/exit 退出宿主。' }).catch(() => {});
  lines.on('line', line => {
    void (async () => {
      const [command, id] = line.trim().split(/\s+/);
      if (command === '/exit') { await shutdown(); return; }
      if (command === '/cancel') { active?.abort(); agent.cancelAll(); return; }
      if (command === '/target') { targetId = id; await write({ kind: 'target', id }); return; }
      if (command === '/get') { await write(tasks.get(id)); return; }
      if (command === '/stop') { await write(await tasks.stop(id)); return; }
      if (command === '/read') { await write(agent.read(id)); return; }
      if (command.startsWith('/')) throw new Error('unknown_debug_command');
      if (!line.trim()) return;
      if (busy) { await write({ kind: 'busy', message: '模型请求处理中；直接查询、停止和取消仍可用。本条未排队。' }); return; }
      busy = true;
      active = new AbortController();
      const signal = AbortSignal.any([active.signal, AbortSignal.timeout(timeoutMs)]);
      try {
        const work = agent.handle({ requestId: randomUUID(), original: line, targetId }, event => write(event, signal), { signal, timeoutMs });
        requestWork = work;
        const result = await work;
        await write({ kind: 'request_result', ...result }, signal);
      } finally { busy = false; active = undefined; requestWork = undefined; }
    })().catch(() => { void write({ kind: 'debug_error', message: '操作失败，请检查任务 ID 或独立任务入口。' }).catch(() => {}); });
  });
  lines.on('close', () => { void shutdown(); });
  return { async close() { active?.abort(); agent.cancelAll(); lines.close(); input.destroy(); await requestWork; } };
}

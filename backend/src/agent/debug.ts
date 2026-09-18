import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { AgentRequests } from './requests.ts';
import type { TaskService } from '../task-service.ts';
import type { LanguageModel } from 'ai';

export function startDebug(tasks: TaskService, model: LanguageModel, shutdown: () => Promise<void>) {
  const agent = new AgentRequests(tasks, model);
  const lines = createInterface({ input: process.stdin });
  const write = (value: unknown) => new Promise<void>((ok, fail) => {
    process.stdout.write(`${JSON.stringify(value)}\n`, error => error ? fail(error) : ok());
  });
  let targetId: string | undefined;
  let busy = false;
  void write({ kind: 'debug_ready', message: '这是常驻 Backend 控制台；关闭它将关闭后端。普通文本发送模型；/target ID 选定任务；/get ID、/stop ID 独立控制；/read REQUEST_ID 读记录；/cancel 取消模型；/exit 退出宿主。' });
  lines.on('line', line => {
    void (async () => {
      const [command, id] = line.trim().split(/\s+/);
      if (command === '/exit') { await shutdown(); return; }
      if (command === '/cancel') { agent.cancelAll(); return; }
      if (command === '/target') { targetId = id; await write({ kind: 'target', id }); return; }
      if (command === '/get') { await write(tasks.get(id)); return; }
      if (command === '/stop') { await write(await tasks.stop(id)); return; }
      if (command === '/read') { await write(agent.read(id)); return; }
      if (command.startsWith('/')) throw new Error('unknown_debug_command');
      if (!line.trim()) return;
      if (busy) { await write({ kind: 'busy', message: '模型请求处理中；直接查询、停止和取消仍可用。本条未排队。' }); return; }
      busy = true;
      try {
        const result = await agent.handle({ requestId: randomUUID(), original: line, targetId }, write);
        await write({ kind: 'request_result', ...result });
      } finally { busy = false; }
    })().catch(() => { void write({ kind: 'debug_error', message: '操作失败，请检查任务 ID 或独立任务入口。' }); });
  });
  lines.on('close', () => { void shutdown(); });
  return { close() { agent.cancelAll(); lines.close(); process.stdin.destroy(); } };
}

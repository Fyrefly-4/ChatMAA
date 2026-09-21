import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../config.ts';
import { taskId } from '../task-contract.ts';

const [command, argument, presentationId] = process.argv.slice(2);
if (!['status', 'catalog', 'catalog-activate', 'conversation', 'task', 'operation', 'present'].includes(command ?? '')) {
  throw new Error('用法：business/cli.ts status | catalog | catalog-activate <快照JSON> | conversation <ID> | task <ID> | operation <JSON文件> | present <方案ID> <展示ID>');
}
const config = loadConfig();
const connection = JSON.parse(readFileSync(resolve(config.dataDir, 'connection.json'), 'utf8'));
if (connection.entry !== 'mvp') throw new Error('当前不是 MVP 业务入口；请核对 Backend 模式');
const base = new URL(connection.address);
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1') throw new Error('只连接本机 Backend');
async function request(path: string, body?: unknown) {
  const response = await fetch(new URL(path, base), { method: body === undefined ? 'GET' : 'POST',
    signal: AbortSignal.timeout(config.httpTimeoutMs * 3),
    headers: { 'content-type': 'application/json', 'x-app-token': connection.token },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json(); if (!response.ok) throw new Error(JSON.stringify(value)); return value;
}
if (command === 'catalog-activate') {
  console.log(JSON.stringify(await request('/business/operations', { operation: 'activate_catalog',
    snapshot: JSON.parse(readFileSync(resolve(argument), 'utf8')) }), null, 2));
} else if (command === 'operation') {
  const body = JSON.parse(readFileSync(resolve(argument), 'utf8'));
  if (body.operation === 'present_plan') throw new Error('请使用 present 命令，先输出方案再发送展示回执');
  console.log(JSON.stringify(await request('/business/operations', body), null, 2));
} else if (command === 'present') {
  taskId(argument); taskId(presentationId);
  const state = await request('/business/status') as { conversations: { id: string }[] };
  let plan;
  for (const conversation of state.conversations) {
    const view = await request(`/business/conversations/${conversation.id}`) as { plans: { id: string }[] };
    plan = view.plans.find(p => p.id === argument); if (plan) break;
  }
  if (!plan) throw new Error('找不到方案');
  await new Promise<void>((ok, fail) => process.stdout.write(JSON.stringify(plan, null, 2) + '\n', error => error ? fail(error) : ok()));
  console.log(JSON.stringify(await request('/business/operations', { operation: 'present_plan', planId: argument, id: presentationId }), null, 2));
} else {
  const path = command === 'conversation' ? `conversations/${taskId(argument)}` : command === 'task' ? `tasks/${taskId(argument)}` : command;
  console.log(JSON.stringify(await request(`/business/${path}`), null, 2));
}

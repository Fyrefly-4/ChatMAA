import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfig } from '../config.ts';
import { taskId } from '../task-contract.ts';

const [command, ...args] = process.argv.slice(2);
const commands: Record<string, number> = { new: 2, message: 3, turn: 1, watch: 1, show: 1, state: 1, confirm: 3, stop: 1, status: 0 };
if (!(command in commands) || args.length !== commands[command]) throw new Error(
  '用法：new <会话ID> <标题> | message <会话ID> <稳定消息ID> <原文> | turn/watch <轮次ID> | show/state <会话ID> | confirm <方案ID> <展示ID> <确认ID> | stop <任务ID> | status');
const config = loadConfig();
if (config.mode !== 'maa-replay') throw new Error('D4 回放客户端拒绝 live 配置');
const connection = JSON.parse(readFileSync(resolve(config.dataDir, 'connection.json'), 'utf8'));
const address = new URL(connection.address);
if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || connection.mode !== 'maa-replay' || connection.entry !== 'mvp-runtime')
  throw new Error('需要本机 maa-replay / mvp-runtime 连接');
const print = (value: unknown) => new Promise<void>((resolve, reject) => process.stdout.write(
  `${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`, error => error ? reject(error) : resolve()));
await print('当前为 maa-replay：执行端是回放；启用的模型仍可能是真实服务。');
async function request(path: string, body?: unknown) {
  const response = await fetch(new URL(path, address), { method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-app-token': connection.token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); return result;
}
const operation = (body: unknown) => request('/business/operations', body);
const segment = (value: string) => encodeURIComponent(taskId(value));
if (command === 'new') await print(await operation({ operation: 'create_conversation', id: args[0], title: args[1] }));
if (command === 'message') {
  const body = { conversationId: taskId(args[0]), messageId: taskId(args[1]), text: args[2] };
  const directory = resolve(config.dataDir, 'runtime-messages'); mkdirSync(directory, { recursive: true });
  const file = resolve(directory, `${createHash('sha256').update(body.messageId).digest('hex')}.json`);
  const content = JSON.stringify(body);
  try { writeFileSync(file, content, { flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || readFileSync(file, 'utf8') !== content) throw error; }
  await print(await request('/runtime/messages', body));
}
if (command === 'status') await print(await request('/runtime/status'));
if (command === 'turn' || command === 'watch') {
  let after = 0;
  const deadline = Date.now() + 65000;
  do {
    const result = await request(`/runtime/turns/${segment(args[0])}?after=${after}`);
    await print(result);
    for (const activity of result.activities) after = Math.max(after, activity.sequence);
    if (command === 'turn' || result.turn.state !== 'processing') break;
    if (Date.now() >= deadline) throw new Error('客户端等待结束；请查询原轮次，不重发新消息');
    await new Promise(resolve => setTimeout(resolve, 300));
  } while (true);
}
if (command === 'state' || command === 'show') {
  const result = await request(`/runtime/conversations/${segment(args[0])}`);
  await print(result);
  if (command === 'show' && result.business.currentPlan) {
    const planId = result.business.currentPlan;
    const receiptId = `cli-${planId}`;
    // Full structured plan has finished writing to stdout before registering this stable receipt.
    await print(await operation({ operation: 'present_plan', planId, id: receiptId }));
  }
}
if (command === 'confirm') await print(await operation({ operation: 'confirm_plan', planId: args[0], presentationId: args[1], id: args[2], source: 'button' }));
if (command === 'stop') await print(await operation({ operation: 'stop_task', id: args[0] }));

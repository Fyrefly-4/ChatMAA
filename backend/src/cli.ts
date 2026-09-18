import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { loadConfig } from './config.ts';
import { submission, taskId } from './task-contract.ts';

const [command, ...args] = process.argv.slice(2);
if (!['submit', 'get', 'stop', 'list', 'shutdown'].includes(command ?? '')) {
  throw new Error('用法：client submit <次数> [操作ID] | get <ID> | stop <ID> | list | shutdown');
}
const config = loadConfig();
const connection = JSON.parse(readFileSync(resolve(config.dataDir, 'connection.json'), 'utf8'));
const url = new URL(connection.address);
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('只连接本机 Backend');
let path = '/tasks'; let method = 'GET'; let body;
if (command === 'submit') {
  if (!args[0] || !/^[1-9][0-9]*$/.test(args[0]) || args.length > 2) throw new Error('需要明确的正整数次数');
  body = submission({ id: args[1] ?? randomUUID(), params: { stage: '1-7', count: Number(args[0]), medicine: 0, premium: 0 } });
  // Persist before the network call: after uncertainty, get/reuse this ID instead of creating another task.
  const directory = resolve(config.dataDir, 'requests'); mkdirSync(directory, { recursive: true });
  const file = resolve(directory, `${createHash('sha256').update(body.id).digest('hex')}.json`);
  try { writeFileSync(file, JSON.stringify(body, null, 2), { flag: 'wx' }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || readFileSync(file, 'utf8') !== JSON.stringify(body, null, 2)) throw error;
  }
  console.log(`操作 ${body.id}：1-7 / ${body.params.count} 次 / 不吃药不碎石；模式 ${connection.mode}`);
  method = 'POST';
} else if (command === 'get' || command === 'stop') {
  if (args.length !== 1) throw new Error('需要一个操作 ID');
  path = `/tasks/${taskId(args[0])}${command === 'stop' ? '/stop' : ''}`;
  if (command === 'stop') method = 'POST';
} else if (command === 'shutdown') { path = '/shutdown'; method = 'POST'; }
const response = await fetch(new URL(path, url), { method, signal: AbortSignal.timeout(config.httpTimeoutMs * 3),
  headers: { 'content-type': 'application/json', 'x-app-token': connection.token },
  body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined });
console.log(JSON.stringify(await response.json(), null, 2));
if (!response.ok) process.exitCode = 1;

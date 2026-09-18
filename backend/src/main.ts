import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { loadConfig } from './config.ts';
import { startHost } from './host.ts';
import { createApp } from './app.ts';

const config = loadConfig();
const host = await startHost(config);
const token = randomUUID();
let closing = false;
const app = createApp(host.tasks, token, () => { void shutdown(); });
async function shutdown() {
  if (closing) return;
  closing = true;
  const result = await host.close();
  console.log(JSON.stringify({ kind: 'shutdown', ...result }));
  await app.close();
  process.exitCode = result.childExited && result.handoffComplete ? 0 : 1;
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
try {
  let address = '';
  for (let attempt = 0; attempt < 30; attempt++) {
    try { address = await app.listen({ host: '127.0.0.1', port: config.port || randomInt(20000, 60000) }); break; }
    catch (error) { if (config.port || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error; }
  }
  if (!address) throw new Error('没有可用的本机端口');
  const connection = resolve(config.dataDir, 'connection.json');
  writeFileSync(connection, JSON.stringify({ address, token, mode: config.mode }, null, 2));
  console.log(JSON.stringify({ kind: 'ready', address, mode: config.mode, connection }));
} catch (error) { await shutdown(); throw error; }

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { loadConfig } from './config.ts';
import { startHost } from './host.ts';
import { createApp } from './app.ts';
import { deepseekModel } from './agent/provider.ts';
import { startDebug } from './agent/debug.ts';

const config = (() => {
  try { return loadConfig(); }
  catch (error) {
    console.log(JSON.stringify({ kind: 'startup_failed', phase: 'configuration', childStarted: false,
      error: error instanceof Error ? error.message : String(error) }));
    throw error;
  }
})();
const model = process.argv.includes('--agent') ? deepseekModel() : undefined;
const host = await startHost(config);
const token = randomUUID();
let closing = false;
let debug: ReturnType<typeof startDebug> | undefined;
const app = createApp(host.tasks, token, () => { void shutdown(); });
async function shutdown() {
  if (closing) return;
  closing = true;
  debug?.close();
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
  if (model) debug = startDebug(host.tasks, model, shutdown);
} catch (error) { await shutdown(); throw error; }

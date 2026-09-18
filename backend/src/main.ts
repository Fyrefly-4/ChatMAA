import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { loadConfig } from './config.ts';
import { startHost } from './host.ts';
import { createApp } from './app.ts';
import { deepseekModel } from './agent/provider.ts';
import { startDebug } from './agent/debug.ts';
import { BrowserRequests } from './browser/requests.ts';
import { repository } from './config.ts';

const config = (() => {
  try { return loadConfig(); }
  catch (error) {
    console.log(JSON.stringify({ kind: 'startup_failed', phase: 'configuration', childStarted: false,
      error: error instanceof Error ? error.message : String(error) }));
    throw error;
  }
})();
const web = process.argv.includes('--web');
if (web && process.argv.includes('--agent')) throw new Error('--web 与 --agent 不能同时使用');
let model;
if (process.argv.includes('--agent')) model = deepseekModel();
if (web) {
  try { model = deepseekModel(); }
  catch { console.log(JSON.stringify({ kind: 'model_unavailable', message: '模型未配置；已有任务仍可查询和停止。' })); }
}
const host = await startHost(config);
const token = randomUUID();
let closing = false;
let debug: ReturnType<typeof startDebug> | undefined;
let address = '';
const browser = web ? new BrowserRequests(host.tasks, model) : undefined;
const webToken = randomUUID();
const developmentOrigin = process.argv.includes('--web-dev') ? 'http://127.0.0.1:5173' : undefined;
const app = createApp(host.tasks, token, () => { void shutdown(); }, browser ? {
  requests: browser, token: webToken, staticRoot: resolve(repository, 'web/dist'), origin: () => address, developmentOrigin,
} : undefined);
async function shutdown() {
  if (closing) return;
  closing = true;
  debug?.close();
  // Cancel and settle bounded model/output work before host.close closes its SQLite.
  await browser?.close();
  const result = await host.close();
  console.log(JSON.stringify({ kind: 'shutdown', ...result }));
  await app.close();
  process.exitCode = result.childExited && result.handoffComplete ? 0 : 1;
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
try {
  for (let attempt = 0; attempt < 30; attempt++) {
    try { address = await app.listen({ host: '127.0.0.1', port: config.port || randomInt(20000, 60000) }); break; }
    catch (error) { if (config.port || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error; }
  }
  if (!address) throw new Error('没有可用的本机端口');
  const connection = resolve(config.dataDir, 'connection.json');
  writeFileSync(connection, JSON.stringify({ address, token, mode: config.mode }, null, 2));
  console.log(JSON.stringify({ kind: 'ready', address, mode: config.mode, connection }));
  if (browser) console.log(JSON.stringify({ kind: 'web_ready', url: `${developmentOrigin ?? address}/#token=${webToken}` }));
  else if (model) debug = startDebug(host.tasks, model, shutdown);
} catch (error) { await shutdown(); throw error; }

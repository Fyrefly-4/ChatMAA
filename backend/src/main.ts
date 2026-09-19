import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { loadConfig } from './config.ts';
import { startHost } from './host.ts';
import { createApp } from './app.ts';
import { deepseekModel } from './agent/provider.ts';
import { startDebug } from './agent/debug.ts';
import { BrowserRequests } from './browser/requests.ts';
import { repository } from './config.ts';
import { prepareDemo, demoTerminal, openDemoBrowser } from './demo.ts';

const demo = process.argv.includes('--demo');
const config = await (async () => {
  try {
    if (!demo) return loadConfig();
    const index = process.argv.indexOf('--demo-config');
    if (index >= 0 && (!process.argv[index + 1] || process.argv[index + 1].startsWith('--'))) throw new Error('--demo-config 缺少路径');
    return await prepareDemo({ replay: process.argv.includes('--replay'), configFile: index < 0 ? undefined : process.argv[index + 1] });
  }
  catch (error) {
    console.log(JSON.stringify({ kind: 'startup_failed', phase: 'configuration', childStarted: false,
      error: error instanceof Error ? error.message : String(error) }));
    throw error;
  }
})();
const web = process.argv.includes('--web');
if (process.argv.includes('--web-dev') && !web) throw new Error('--web-dev 须与 --web 同用');
if (web && process.argv.includes('--agent')) throw new Error('--web 与 --agent 不能同时使用');
const noModel = demo && process.argv.includes('--no-model');
if (demo && !noModel && existsSync(resolve(repository, '.env'))) process.loadEnvFile(resolve(repository, '.env'));
let model;
if (process.argv.includes('--agent')) model = deepseekModel();
if (web) {
  try { if (!noModel) model = deepseekModel(); else throw new Error('model disabled'); }
  catch { console.log(JSON.stringify({ kind: 'model_unavailable', message: '模型未配置；已有任务仍可查询和停止。' })); }
}
let stopRequested = false;
let listening = false;
let requestStop = () => { stopRequested = true; };
const closeTerminal = demo ? demoTerminal(() => requestStop()) : undefined;
const host = await startHost(config).catch(error => { closeTerminal?.(); throw error; });
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
  await debug?.close();
  // Cancel and settle bounded model/output work before host.close closes its SQLite.
  await browser?.close();
  // Drain direct HTTP task operations before the host closes their shared storage.
  await app.close();
  const result = await host.close();
  console.log(JSON.stringify({ kind: 'shutdown', ...result }));
  process.exitCode = result.childExited && result.handoffComplete ? 0 : 1;
  closeTerminal?.();
  if (demo) console.log(process.exitCode === 0 ? '已完成证据交接，Python 已退出；Backend 即将退出。请核对游戏现场。' : '退出交接未确认，请保留记录并核对原服务及游戏现场，不要重开执行。');
}
requestStop = () => { stopRequested = true; if (listening) void shutdown(); };
process.on('SIGINT', () => requestStop());
process.on('SIGTERM', () => requestStop());
try {
  for (let attempt = 0; attempt < 30 && !stopRequested; attempt++) {
    try { address = await app.listen({ host: '127.0.0.1', port: config.port || randomInt(20000, 60000) }); break; }
    catch (error) { if (config.port || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error; }
  }
  if (!address && !stopRequested) throw new Error('没有可用的本机端口');
  listening = true;
  if (stopRequested) await shutdown();
  else {
    const connection = resolve(config.dataDir, 'connection.json');
    writeFileSync(connection, JSON.stringify({ address, token, mode: config.mode }, null, 2));
    console.log(JSON.stringify({ kind: 'ready', address, mode: config.mode, connection }));
    if (browser) {
      const url = `${developmentOrigin ?? address}/#token=${webToken}`;
      console.log(JSON.stringify({ kind: 'web_ready', url }));
      if (demo) {
        console.log('页面已就绪。按 Ctrl+C 退出；关闭网页不会停止任务。');
        if (!process.argv.includes('--no-browser')) void openDemoBrowser(url).catch(() => console.error('无法自动打开浏览器，请使用上方 web_ready.url 在本机打开。'));
      }
    } else if (model) debug = startDebug(host.tasks, model, shutdown);
  }
} catch (error) { await shutdown(); throw error; }

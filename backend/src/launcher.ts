// Local desktop launcher: lifecycle and diagnostics only; never submits business operations.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { loadConfig, repository } from './config.ts';

const args = process.argv.slice(2);
const value = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const directory = resolve(value('--session') ?? resolve(repository, '.artifacts/launcher', `run-${Date.now()}`));
const configFile = resolve(value('--config') ?? resolve(repository, '.artifacts/mvp/config.json'));
mkdirSync(directory, { recursive: true });
const stateFile = resolve(directory, 'session.json');
const state: Record<string, any> = { startedAt: new Date().toISOString(), directory, configFile, status: 'starting' };
const secrets = [process.env.CHATMAA_MODEL_API_KEY];
const envFile = resolve(repository, '.env');
if (existsSync(envFile)) {
  const match = readFileSync(envFile, 'utf8').match(/^\s*CHATMAA_MODEL_API_KEY\s*=\s*(.*)$/m);
  if (match) secrets.push(match[1].trim().replace(/^['"]|['"]$/g, ''));
}
const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2));
const log = (message: string) => {
  for (const secret of secrets) if (secret) message = message.split(secret).join('[redacted]');
  appendFileSync(resolve(directory, 'launcher.jsonl'), JSON.stringify({ at: new Date().toISOString(), message }) + '\n');
};
let child: ReturnType<typeof spawn> | undefined;
let lock: string | undefined;
let stopping = false;
let stopPending = false;
async function stop() {
  stopPending = true;
  if (stopping || !child || child.exitCode !== null) return;
  if (!state.url) return; // A close during startup must be delivered once this child is ready.
  try {
    const connection = JSON.parse(readFileSync(resolve(state.dataDir, 'connection.json'), 'utf8'));
    const url = new URL(connection.address);
    if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:' || connection.entry !== 'mvp-runtime') throw new Error('连接信息不属于本机 MVP');
    const result = await fetch(new URL('/shutdown', url), { method: 'POST',
      headers: { 'x-app-token': connection.token, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) });
    if (!result.ok) throw new Error(`退出请求失败 ${result.status}`);
    stopping = true; state.status = 'stopping'; save();
  } catch { state.message = '尚未成功请求退出，请等待启动完成后重试；保留窗口和记录。'; save(); }
}
try {
  const config = loadConfig(configFile);
  state.dataDir = config.dataDir; state.mode = config.mode;
  lock = resolve(repository, '.artifacts/mvp/launcher.lock'); mkdirSync(dirname(lock), { recursive: true });
  if (existsSync(lock)) {
    const previous = JSON.parse(readFileSync(lock, 'utf8'));
    let alive = true;
    try { process.kill(previous.pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
    if (alive) throw new Error('ChatMAA 启动窗口已在运行，请回到原窗口。');
    throw new Error('上次启动窗口异常退出，请先核对原 Backend／Python 和游戏现场，再处理 .artifacts/mvp/launcher.lock。');
  }
  writeFileSync(lock, JSON.stringify({ pid: process.pid, directory }), { flag: 'wx' });
  state.owner = true; save();
  child = spawn(process.execPath, [resolve(repository, 'backend/src/mvp-entry.ts'), '--runtime', '--web', ...(args.includes('--no-model') ? ['--no-model'] : [])],
    { cwd: repository, env: { ...process.env, CHATMAA_CONFIG: configFile }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  state.pid = child.pid; save();
  const consume = (line: string) => {
    try {
      const event = JSON.parse(line);
      if (event.kind === 'web_ready') { state.url = event.url; state.status = 'ready'; save(); log('网页已就绪'); if (stopPending) void stop(); return; }
      if (event.kind === 'shutdown') state.shutdown = event;
      if (event.kind === 'model_unavailable') state.message = '模型未配置或不可用；仍可查看和停止已有任务。';
    } catch { /* Plain diagnostic line. */ }
    // Startup URL stays only in the private session file, never in the diagnostic log.
    log(line.replace(/#token=[^\s"']+/g, '#token=[redacted]')); save();
  };
  createInterface({ input: child.stdout! }).on('line', consume);
  createInterface({ input: child.stderr! }).on('line', consume);
  const input = createInterface({ input: process.stdin });
  input.on('line', line => { if (line.trim() === 'stop') void stop(); });
  input.on('close', () => { void stop(); });
  process.on('SIGINT', () => { void stop(); });
  process.on('SIGTERM', () => { void stop(); });
  await new Promise<void>((ok, fail) => { child!.once('error', fail); child!.once('close', code => { state.exitCode = code; ok(); }); });
  input.close(); process.stdin.pause();
  state.status = state.shutdown?.handoffComplete && state.shutdown?.childExited && state.exitCode === 0 ? 'completed' : 'failed';
  state.finishedAt = new Date().toISOString(); save();
  // Keep the lock after an uncertain child exit for explicit recovery.
  if (state.status === 'completed' || !existsSync(resolve(config.dataDir, 'connection.json'))) unlinkSync(lock);
  process.exitCode = state.status === 'completed' ? 0 : 1;
} catch (error) {
  state.status = 'failed'; state.message = error instanceof Error ? error.message : String(error); save(); log(state.message);
  if (state.owner && !child && lock) unlinkSync(lock);
  process.exitCode = 1;
}

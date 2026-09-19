import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { loadConfig, repository } from './config.ts';
import type { Config } from './config.ts';
import type { ReadStream } from 'node:tty';

type Window = { Id: number; ProcessName: string; hwnd: number };
type Ask = (question: string) => Promise<string>;
const powershell = 'powershell.exe';
const text = (file: string) => readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();

export function checkDemoFiles(root = repository) {
  if (process.versions.node !== text(resolve(root, '.node-version'))) {
    throw new Error(`Node 版本不符：需要 ${text(resolve(root, '.node-version'))}，当前 ${process.versions.node}`);
  }
  const require = createRequire(resolve(root, 'backend/package.json'));
  try { for (const name of ['fastify', '@fastify/static', 'ai', '@ai-sdk/openai']) require.resolve(name); }
  catch { throw new Error('Backend 依赖缺失。请在仓库根目录执行：npm --prefix backend ci'); }
  const index = resolve(root, 'web/dist/index.html');
  const buildHelp = '请执行 npm --prefix web ci，然后 npm --prefix web run build';
  if (!existsSync(index)) throw new Error(`网页尚未构建。${buildHelp}`);
  for (const asset of text(index).matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)) {
    if (!existsSync(resolve(root, 'web/dist', asset[1].slice(1)))) throw new Error(`网页构建不完整。${buildHelp}`);
  }
  function newest(path: string): number {
    const stat = statSync(path);
    return stat.isDirectory() ? Math.max(0, ...readdirSync(path).map(name => newest(resolve(path, name)))) : stat.mtimeMs;
  }
  const sources = ['web/src', 'web/index.html', 'web/package-lock.json', 'web/vite.config.ts'];
  if (sources.some(path => existsSync(resolve(root, path)) && newest(resolve(root, path)) > statSync(index).mtimeMs)) {
    throw new Error(`网页源码比构建新。${buildHelp}`);
  }
}

export async function selectWindow(windows: Window[], ask: Ask, log = console.log): Promise<Window> {
  if (!windows.length) throw new Error('没有找到“明日方舟”窗口。请先启动并登录官方桌面端，再运行本命令。');
  if (windows.length === 1) return windows[0];
  windows.forEach((window, i) => log(`${i + 1}. ${window.ProcessName}，进程 ${window.Id}，窗口 ${window.hwnd}`));
  const answer = await ask('发现多个游戏窗口，请输入本次目标序号：');
  if (!/^[1-9]\d*$/.test(answer) || !windows[Number(answer) - 1]) throw new Error('窗口序号无效，未启动 Backend。');
  return windows[Number(answer) - 1];
}

function gameWindows(): Window[] {
  const command = "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); @(Get-Process | Where-Object { $_.MainWindowTitle -eq '明日方舟' -and $_.MainWindowHandle.ToInt64() -gt 0 } | Select-Object Id, ProcessName, @{Name='hwnd';Expression={$_.MainWindowHandle.ToInt64()}}) | ConvertTo-Json -Compress";
  const output = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  const result = output.trim() ? JSON.parse(output) : [];
  return Array.isArray(result) ? result : [result];
}

// Only configuration and read-only process discovery; no MaaCore load or model request.
export async function prepareDemo(options: { replay: boolean; configFile?: string; ask?: Ask; windows?: () => Window[] }): Promise<Config> {
  checkDemoFiles();
  const ask: Ask = options.ask ?? (async question => {
    if (!process.stdin.isTTY) throw new Error(`${question}请在交互终端重新运行，或填写本地配置。`);
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try { return (await input.question(question)).trim().replace(/^"|"$/g, ''); }
    finally { input.close(); }
  });
  const mode = options.replay ? 'maa-replay' : 'maa-live';
  const file = resolve(options.configFile ?? resolve(repository, '.artifacts/demo', options.replay ? 'replay.json' : 'live.json'));
  let raw: Record<string, unknown> = existsSync(file) ? JSON.parse(text(file)) : {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Demo 配置必须是 JSON 对象');
  if (raw.mode && raw.mode !== mode) throw new Error('配置模式与启动参数不符；回放使用 -Replay，不自动切换模式。');
  raw = { ...raw, mode };
  let python = resolve(dirname(file), typeof raw.python === 'string' ? raw.python : resolve(repository, 'adapter/maa/.venv/Scripts/python.exe'));
  if (!existsSync(python)) {
    const answer = await ask('找不到 Python。请输入已准备好的 Python 解释器绝对路径（留空退出）：');
    if (!answer) throw new Error('请先按 docs/engineering/demo.md 准备 Python venv 与锁定依赖。');
    python = resolve(answer);
  }
  const probeOptions = { encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] } as const;
  let version: string;
  try { version = execFileSync(python, ['-c', 'import platform,struct; print(platform.python_version()); assert struct.calcsize("P")==8'], { ...probeOptions, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { throw new Error('Python 无法运行或不是 x64；请按 docs/engineering/demo.md 准备工程 venv。'); }
  const expected = text(resolve(repository, '.python-version'));
  if (version !== expected) throw new Error(`Python 版本不符：需要 ${expected}，当前 ${version}。请用正确解释器准备工程 venv，不要依赖 py 默认版本。`);
  try { execFileSync(python, ['-c', 'import fastapi,uvicorn'], { ...probeOptions, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { throw new Error(`Python 依赖缺失。请执行：& '${python}' -m pip install -r adapter/maa/requirements.lock`); }
  raw.python = python;
  raw.dataDir ??= resolve(repository, options.replay ? '.artifacts/replay' : '.artifacts/live');
  if (!options.replay) {
    let installation = typeof raw.installation === 'string' ? resolve(dirname(file), raw.installation) : '';
    if (!installation || !existsSync(resolve(installation, 'MaaCore.dll'))) {
      const answer = await ask('请输入 MAA v6.17.5 安装目录（含 MaaCore.dll，留空退出）：');
      if (!answer) throw new Error('未提供 MAA 安装目录，未启动 Backend。');
      installation = resolve(answer);
    }
    if (!existsSync(resolve(installation, 'MaaCore.dll')) || !existsSync(resolve(installation, 'resource/tasks/tasks.json'))) {
      throw new Error('MAA 安装不完整：需要 MaaCore.dll 和 resource/tasks/tasks.json。');
    }
    raw.installation = installation;
    const window = await selectWindow((options.windows ?? gameWindows)(), ask);
    raw.hwnd = window.hwnd; // Never reuse a stale handle from the saved configuration.
    console.log(`目标窗口：${window.ProcessName}，进程 ${window.Id}，句柄 ${window.hwnd}`);
  }
  // Validate before replacing the user's saved configuration.
  const config = loadConfig(file, raw);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
  console.log(`模式：${options.replay ? '回放执行端（页面请求仍可能调用真实模型）' : '真实 Demo（不会自动提交任务）'}\n配置：${file}\n数据：${config.dataDir}\n保留历史记录；环境未知时不自动解锁或更换目录。`);
  return config;
}

export function demoTerminal(stop: () => void, input: NodeJS.ReadStream = process.stdin) {
  const terminal = input as ReadStream;
  const wasRaw = terminal.isRaw;
  let line = '';
  const onData = (data: Buffer) => {
    if (data.includes(3)) { stop(); return; }
    line += data.toString();
    if (/[\r\n]/.test(line)) {
      if (line.trim().toLowerCase() === 'exit') stop();
      line = '';
    }
    if (line.length > 100) line = '';
  };
  const onEnd = () => stop();
  if (input.isTTY) terminal.setRawMode(true); // Ctrl+C is input, not a console-group termination.
  input.on('data', onData);
  input.once('end', onEnd);
  input.resume();
  return () => {
    input.off('data', onData);
    input.off('end', onEnd);
    if (input.isTTY) terminal.setRawMode(wasRaw);
    input.pause();
  };
}

export function openDemoBrowser(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !/^#token=[\w-]+$/.test(parsed.hash)) throw new Error('拒绝打开非本机启动地址');
  return new Promise((ok, fail) => {
    // URL is validated and passed as an environment value, never shell source.
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:CHATMAA_DEMO_URL'], {
      windowsHide: true, stdio: 'ignore', timeout: 10000,
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'DEEPSEEK_API_KEY')), CHATMAA_DEMO_URL: url },
    });
    child.once('error', fail);
    child.once('exit', code => code === 0 ? ok() : fail(new Error(`浏览器启动失败：${code}`)));
  });
}

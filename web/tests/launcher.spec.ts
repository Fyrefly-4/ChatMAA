import { test, expect } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, symlinkSync, utimesSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkDemoFiles, prepareDemo, selectWindow } from '../../backend/src/demo.ts';
import { repository } from '../../backend/src/config.ts';

test('preflight distinguishes missing dependencies, incomplete builds and stale builds', () => {
  const root = resolve(repository, '.artifacts/checks', `preflight ${randomUUID()}`);
  mkdirSync(resolve(root, 'backend'), { recursive: true });
  writeFileSync(resolve(root, '.node-version'), process.versions.node);
  writeFileSync(resolve(root, 'backend/package.json'), '{}');
  expect(() => checkDemoFiles(root)).toThrow('Backend 依赖缺失');
  symlinkSync(resolve(repository, 'backend/node_modules'), resolve(root, 'backend/node_modules'), 'junction');
  expect(() => checkDemoFiles(root)).toThrow('网页尚未构建');
  mkdirSync(resolve(root, 'web/dist/assets'), { recursive: true });
  const index = resolve(root, 'web/dist/index.html');
  writeFileSync(index, '<script src="/assets/main.js"></script>');
  expect(() => checkDemoFiles(root)).toThrow('网页构建不完整');
  writeFileSync(resolve(root, 'web/dist/assets/main.js'), '');
  expect(() => checkDemoFiles(root)).not.toThrow();
  mkdirSync(resolve(root, 'web/src'));
  writeFileSync(resolve(root, 'web/src/App.tsx'), '// changed');
  utimesSync(index, 1, 1);
  expect(() => checkDemoFiles(root)).toThrow('网页源码比构建新');
});

test('root command fails without starting a host when the explicit mode is wrong', () => {
  const run = resolve(repository, '.artifacts/checks', `bad config ${randomUUID()}`);
  mkdirSync(run, { recursive: true });
  const file = resolve(run, 'live.json');
  writeFileSync(file, JSON.stringify({ mode: 'maa-live' }));
  const result = spawnSync('pwsh', ['-NoProfile', '-File', resolve(repository, 'start-demo.ps1'), '-Replay', '-NoModel', '-NoBrowser', '-Config', file], {
    windowsHide: true, encoding: 'utf8', timeout: 10000,
  });
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).toContain('配置模式与启动参数不符');
  expect(result.stdout).not.toContain('"kind":"ready"');
});

test('launcher selects current windows and preserves explicit config and data without starting live execution', async () => {
  const run = resolve(repository, '.artifacts/checks', `demo config ${randomUUID()}`);
  mkdirSync(resolve(run, 'maa/resource/tasks'), { recursive: true });
  writeFileSync(resolve(run, 'maa/MaaCore.dll'), 'fixture only, never loaded');
  // The old, incorrect flat layout must not pass the fixed-version preflight.
  writeFileSync(resolve(run, 'maa/resource/tasks.json'), '{}');
  const file = resolve(run, 'live.json');
  const dataDir = resolve(repository, '.artifacts/live');
  writeFileSync(file, JSON.stringify({ mode: 'maa-live', installation: './maa', dataDir, hwnd: 999 }));
  const windows = [{ Id: 1, ProcessName: 'fixture-one', hwnd: 11 }, { Id: 2, ProcessName: 'fixture-two', hwnd: 22 }];
  await expect(prepareDemo({ replay: false, configFile: file, windows: () => windows, ask: async () => '2' })).rejects.toThrow('resource/tasks/tasks.json');
  // Fixed v6.17.5 layout, also used by adapter/maa/contract.py resource patches.
  writeFileSync(resolve(run, 'maa/resource/tasks/tasks.json'), '{}');
  const config = await prepareDemo({ replay: false, configFile: file, windows: () => windows, ask: async () => '2' });
  expect(config.hwnd).toBe(22);
  expect(config.dataDir).toBe(dataDir);
  expect(JSON.parse(readFileSync(file, 'utf8')).hwnd).toBe(22);
  expect(await selectWindow([windows[0]], async () => { throw new Error('unexpected prompt'); })).toEqual(windows[0]);
  await expect(selectWindow([], async () => '1')).rejects.toThrow('没有找到');
  await expect(selectWindow(windows, async () => '3', () => {})).rejects.toThrow('窗口序号无效');
  const before = readFileSync(file, 'utf8');
  await expect(prepareDemo({ replay: true, configFile: file })).rejects.toThrow('配置模式');
  expect(readFileSync(file, 'utf8')).toBe(before);
});

test('root PowerShell launcher serves replay and Ctrl+C input completes the existing shutdown handoff', async ({ page }) => {
  const run = resolve(repository, '.artifacts/checks', `launcher with spaces ${randomUUID()}`);
  mkdirSync(run, { recursive: true });
  const file = resolve(run, 'config with spaces.json');
  writeFileSync(file, JSON.stringify({ mode: 'maa-replay', dataDir: resolve(run, 'data') }));
  const child = spawn('pwsh', ['-NoProfile', '-File', resolve(repository, 'start-demo.ps1'), '-Replay', '-NoModel', '-NoBrowser', '-Config', file], {
    cwd: run, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, DEEPSEEK_API_KEY: '', CHATMAA_CONFIG: 'must-not-read-this-local-config.json' },
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const exit = new Promise<number | null>((ok, fail) => { child.once('exit', ok); child.once('error', fail); });
  const messages = () => output.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  try {
    await expect.poll(() => messages().find(message => message.kind === 'web_ready'), { timeout: 15000 }).toBeTruthy();
    await page.goto(messages().find(message => message.kind === 'web_ready').url);
    await expect(page.getByText('离线回放 · 不操作游戏', { exact: true })).toBeVisible();
    await expect(page.getByText('模型尚未配置；已有任务仍可查询和停止。')).toBeVisible();
    await expect(page.getByRole('heading', { name: '尚无已受理任务' })).toBeVisible();
    child.stdin.write('\x03');
    await expect.poll(() => child.exitCode, { timeout: 12000 }).toBe(0);
    expect(await exit).toBe(0);
    expect(messages().find(message => message.kind === 'shutdown')).toMatchObject({ handoffComplete: true, childExited: true, finalTasks: [] });
    expect(readFileSync(file, 'utf8')).toContain(resolve(run, 'data').replaceAll('\\', '\\\\'));
  } finally {
    if (child.exitCode === null) {
      child.stdin.end('exit\n');
      // Cleanup requests the same host endpoint; never use termination as proof of handoff.
      try {
        const connection = JSON.parse(readFileSync(resolve(run, 'data/connection.json'), 'utf8'));
        await fetch(new URL('/shutdown', connection.address), { method: 'POST', headers: { 'x-app-token': connection.token, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) });
      } catch { /* startup failures may have no connection */ }
      const timer = setTimeout(() => child.kill(), 15000);
      await exit;
      clearTimeout(timer);
    }
  }
});

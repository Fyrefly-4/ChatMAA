import { test } from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { repository } from '../src/config.ts';
import { acquireLauncherGuard } from '../src/launcher-guard.ts';
import assert from 'node:assert/strict';

test('运行环境选择在没有 PATH 时复用保存路径，并拒绝错误版本', () => {
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve(repository, 'scripts/launcher/test_runtime.ps1'),
    '-NodePath', process.execPath, '-PythonPath', resolve(repository, 'adapter/maa/.venv/Scripts/python.exe')], { windowsHide: true, timeout: 30000 });
});
test('启动器互斥拒绝重复占用，正常释放后可重新获得', async () => {
  const scope = `guard-test-${process.pid}`;
  const release = await acquireLauncherGuard(scope);
  try { await assert.rejects(acquireLauncherGuard(scope), /已在运行/); } finally { await release(); }
  await (await acquireLauncherGuard(scope))();
});
test('启动器进程异常退出后，系统自动释放互斥', async () => {
  const scope = `guard-crash-${process.pid}`;
  const script = `import { acquireLauncherGuard } from './backend/src/launcher-guard.ts'; await acquireLauncherGuard('${scope}'); console.log('ready');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: repository, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<void>(ok => child.once('close', () => ok()));
  try {
    await new Promise<void>((ok, fail) => { child.stdout.once('data', () => ok()); child.once('error', fail); child.once('exit', () => fail(new Error('互斥夹具提前退出'))); });
    await assert.rejects(acquireLauncherGuard(scope), /已在运行/);
  } finally { child.kill(); await exited; }
  await (await acquireLauncherGuard(scope))();
});

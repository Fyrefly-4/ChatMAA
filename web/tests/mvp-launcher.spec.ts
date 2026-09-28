import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

test('MVP 用户入口：正式回放、重复启动保护和正常退出归档', async () => {
  const root = resolve(import.meta.dirname, '../..');
  const directory = resolve(root, '.artifacts/checks', `mvp-launcher-${Date.now()}`);
  mkdirSync(directory, { recursive: true });
  const config = resolve(directory, 'config.json');
  writeFileSync(config, JSON.stringify({ mode: 'maa-replay', dataDir: directory }));
  const session = resolve(directory, 'session');
  const start = (where: string) => spawn(process.execPath, [resolve(root, 'backend/src/launcher.ts'), '--config', config, '--session', where, '--no-model'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const child = start(session);
  let errors = ''; child.stderr.on('data', c => errors += c);
  const ended = new Promise(resolve => child.on('close', resolve));
  const state = () => { try { return JSON.parse(readFileSync(resolve(session, 'session.json'), 'utf8')); } catch { return {}; } };
  try {
    await expect.poll(() => state().status, { timeout: 15000, message: errors }).toBe('ready');
    const url = new URL(state().url);
    const response = await fetch(`${url.origin}/api/status`, { headers: { 'x-web-token': new URLSearchParams(url.hash.slice(1)).get('token')! } });
    const status = await response.json(); expect(status.entry).toBe('mvp-runtime'); expect(status.runtime.available).toBe(false);
    const duplicateDir = resolve(directory, 'duplicate'); const duplicate = start(duplicateDir);
    await new Promise(resolve => duplicate.on('close', resolve));
    expect(JSON.parse(readFileSync(resolve(duplicateDir, 'session.json'), 'utf8')).message).toContain('已在运行');
    expect(existsSync(resolve(directory, 'worker-audit.jsonl'))).toBe(false);
  } finally {
    child.stdin.write('stop\n');
    await expect.poll(() => state().status, { timeout: 15000 }).toBe('completed');
    await ended;
  }
  expect(state().shutdown.handoffComplete).toBe(true); expect(state().shutdown.childExited).toBe(true);
  expect(readFileSync(resolve(session, 'launcher.jsonl'), 'utf8')).not.toContain('#token=');
});

test('预检失败后保留具体原因，历史连接文件不阻止修正后重试', async () => {
  const root = resolve(import.meta.dirname, '../..');
  const directory = resolve(root, '.artifacts/checks', `mvp-retry-${Date.now()}`);
  mkdirSync(directory, { recursive: true });
  const config = resolve(directory, 'config.json');
  writeFileSync(resolve(directory, 'connection.json'), JSON.stringify({ address: 'http://127.0.0.1:1', token: 'old', entry: 'mvp-runtime' }));
  writeFileSync(config, JSON.stringify({ mode: 'maa-replay', dataDir: directory, python: resolve(directory, 'missing-python.exe') }));
  const run = (session: string) => spawn(process.execPath, [resolve(root, 'backend/src/launcher.ts'), '--config', config, '--session', session, '--no-model'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const failedSession = resolve(directory, 'failed');
  const failed = run(failedSession); await new Promise(ok => failed.once('close', ok));
  const failure = JSON.parse(readFileSync(resolve(failedSession, 'session.json'), 'utf8'));
  expect(failure.status).toBe('failed'); expect(failure.message).toContain('missing-python.exe'); expect(failure.pid).toBeUndefined();
  writeFileSync(config, JSON.stringify({ mode: 'maa-replay', dataDir: directory }));
  const retrySession = resolve(directory, 'retry'); const child = run(retrySession);
  const ended = new Promise(ok => child.once('close', ok));
  const state = () => { try { return JSON.parse(readFileSync(resolve(retrySession, 'session.json'), 'utf8')); } catch { return {}; } };
  try { await expect.poll(() => state().status, { timeout: 15000 }).toBe('ready'); }
  finally { child.stdin.write('stop\n'); await expect.poll(() => state().status, { timeout: 15000 }).toBe('completed'); await ended; }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { repository } from '../src/config.ts';

test('agent debug console starts one host and explicit exit hands it off without calling a model', async () => {
  const directory = resolve(repository, '.artifacts/checks', `agent-debug-${Date.now()}`);
  mkdirSync(directory, { recursive: true });
  const config = resolve(directory, 'config.json');
  writeFileSync(config, JSON.stringify({ mode: 'maa-replay', dataDir: directory,
    python: resolve(repository, 'adapter/maa/.venv/Scripts/python.exe'), stopDeadlineMs: 3000, httpTimeoutMs: 1000 }));
  const child = spawn(process.execPath, [resolve(repository, 'backend/src/main.ts'), '--agent'], {
    env: { ...process.env, CHATMAA_CONFIG: config, DEEPSEEK_API_KEY: 'offline-unused-placeholder' },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const events: Record<string, any>[] = [];
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  createInterface({ input: child.stdout }).on('line', line => {
    const event = JSON.parse(line); events.push(event);
    if (event.kind === 'debug_ready') child.stdin.write('/exit\n');
  });
  const timer = setTimeout(() => child.kill(), 15000);
  try {
    const code = await new Promise<number | null>((ok, fail) => { child.once('exit', ok); child.once('error', fail); });
    assert.equal(code, 0, `${stderr}\n${JSON.stringify(events.map(e => ({ kind: e.kind, childExited: e.childExited, handoffComplete: e.handoffComplete })))}`);
    assert.equal(events.filter(e => e.kind === 'ready').length, 1);
    assert.equal(events.filter(e => e.kind === 'debug_ready').length, 1);
    const shutdown = events.find(e => e.kind === 'shutdown');
    assert.equal(shutdown?.childExited, true); assert.equal(shutdown?.handoffComplete, true);
    assert.equal(events.filter(e => e.kind === 'request').length, 0);
  } finally { clearTimeout(timer); }
});

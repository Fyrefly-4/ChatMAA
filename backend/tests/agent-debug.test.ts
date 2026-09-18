import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { repository } from '../src/config.ts';
import { PassThrough, Writable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { MockLanguageModelV4 } from 'ai/test';
import { startDebug } from '../src/agent/debug.ts';
import type { TaskService } from '../src/task-service.ts';

test('debug final output timeout or cancel releases busy for another request', async () => {
  for (const cancel of [false, true]) {
    const db = new DatabaseSync(':memory:');
    const input = new PassThrough();
    let release!: () => void;
    const output = new Writable({ write(chunk, _encoding, done) {
      if (JSON.parse(String(chunk)).kind === 'request_result' && !release) release = done;
      else done();
    } });
    let calls = 0;
    const model = new MockLanguageModelV4({ doGenerate: async () => { calls++; throw new Error('offline failure'); } });
    const debug = startDebug({ store: { db, get: () => undefined } } as unknown as TaskService,
      model, async () => {}, { input, output, timeoutMs: cancel ? 2000 : 100 });
    try {
      input.write('你好\n');
      const deadline = Date.now() + 1000;
      while (!release) { assert(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10)); }
      if (cancel) input.write('/cancel\n');
      await new Promise(resolve => setTimeout(resolve, cancel ? 30 : 150));
      release();
      input.write('再试一次\n');
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(calls, 2);
    } finally { debug.close(); output.destroy(); db.close(); }
  }
});

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

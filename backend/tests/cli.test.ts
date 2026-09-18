import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfig, repository } from '../src/config.ts';

const execute = promisify(execFile);
const pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

test('configuration defaults to offline and rejects incomplete live settings', () => {
  const data = resolve(repository, '.artifacts/checks', `config-${Date.now()}`);
  mkdirSync(data, { recursive: true });
  const file = resolve(data, 'config.json');
  writeFileSync(file, '{}');
  const defaults = loadConfig(file);
  assert.equal(defaults.mode, 'maa-replay');
  assert.equal(defaults.python, resolve(repository, 'adapter/maa/.venv/Scripts/python.exe'));
  assert.equal(defaults.dataDir, resolve(repository, '.artifacts/replay'));
  writeFileSync(file, '{"mode":"maa-live"}');
  assert.throws(() => loadConfig(file), /installation/);
  writeFileSync(file, '{"mode":"maa-live","dataDir":"another-directory"}');
  assert.throws(() => loadConfig(file), /live dataDir/);
  writeFileSync(resolve(data, 'MaaCore.dll'), 'configuration fixture only');
  for (const dataDir of [undefined, resolve(repository, '.artifacts/live-wizard/run-config-test/data')]) {
    writeFileSync(file, JSON.stringify({mode:'maa-live',installation:data,hwnd:1,dataDir}));
    assert.equal(loadConfig(file).dataDir, dataDir ?? resolve(repository,'.artifacts/live'));
  }
  for (const dataDir of [resolve(repository,'.artifacts/live-wizard/other/data'),
    resolve(repository,'.artifacts/live-wizard/run-test/../../outside/data')]) {
    writeFileSync(file, JSON.stringify({mode:'maa-live',installation:data,hwnd:1,dataDir}));
    assert.throws(() => loadConfig(file), /live dataDir/);
  }
});

test('configuration failure reports that the executor never started', async () => {
  const data = resolve(repository, '.artifacts/checks', `startup-error-${Date.now()}`);
  mkdirSync(data, { recursive: true });
  const configFile = resolve(data, 'config.json');
  writeFileSync(configFile, JSON.stringify({ mode: 'maa-replay', dataDir: data, pollMs: 0 }));
  await assert.rejects(execute(process.execPath, [resolve(repository, 'backend/src/main.ts')], {
    env: { ...process.env, CHATMAA_CONFIG: configFile }, windowsHide: true, timeout: 10000,
  }), (error: unknown) => {
    const event = JSON.parse((error as { stdout: string }).stdout.trim());
    assert.equal(event.kind, 'startup_failed');
    assert.equal(event.phase, 'configuration');
    assert.equal(event.childStarted, false);
    assert.match(event.error, /pollMs/);
    return true;
  });
  assert.equal(existsSync(resolve(data, 'connection.json')), false);
  assert.equal(existsSync(resolve(data, 'executor.sqlite')), false);
});

test('separate CLI processes submit, query and stop; host shutdown hands off evidence', async () => {
  const data = resolve(repository, '.artifacts/checks', `cli-${Date.now()}`);
  mkdirSync(data, { recursive: true });
  const configFile = resolve(data, 'config.json');
  writeFileSync(configFile, JSON.stringify({ mode: 'maa-replay', dataDir: data,
    python: resolve(repository, 'adapter/maa/.venv/Scripts/python.exe'), pollMs: 60, httpTimeoutMs: 1000,
    leaseMs: 5000, stopDeadlineMs: 3000 }));
  const env = { ...process.env, CHATMAA_CONFIG: configFile };
  const server = spawn(process.execPath, [resolve(repository, 'backend/src/main.ts')], { env, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let errors = ''; let exited = false;
  server.stdout.on('data', chunk => { output += chunk; });
  server.stderr.on('data', chunk => { errors += chunk; });
  server.on('exit', () => { exited = true; });
  const client = async (...args: string[]) => (await execute(process.execPath,
    [resolve(repository, 'backend/src/cli.ts'), ...args], { env, windowsHide: true, timeout: 10000 })).stdout;
  const query = async (id: string) => JSON.parse(await client('get', id));
  try {
    const deadline = Date.now() + 15000;
    while (!existsSync(resolve(data, 'connection.json')) && Date.now() < deadline && !exited) await pause(50);
    assert(!exited, errors);
    assert(existsSync(resolve(data, 'connection.json')), `startup timeout: ${errors}`);
    assert.deepEqual(JSON.parse(await client('list')), []);
    const submitted = await client('submit', '1', 'normal');
    assert(submitted.startsWith('操作 normal：1-7 / 1 次 / 不吃药不碎石；模式 maa-replay'));
    let normal;
    do { await pause(50); normal = await query('normal'); } while (normal.state !== 'ended' && Date.now() < deadline);
    assert.equal(normal.confirmed, 1); assert.equal(normal.device, 'ready');
    await client('submit', '100', 'stop');
    let running;
    do { await pause(50); running = await query('stop'); } while (running.confirmed < 1 && Date.now() < deadline);
    assert.equal(JSON.parse(await client('stop', 'stop')).confirmed, false);
    let stopped;
    do { await pause(50); stopped = await query('stop'); } while (stopped.state !== 'ended' && Date.now() < deadline);
    assert.equal(stopped.automation_stopped, true);
    assert(stopped.confirmed >= 1 && stopped.confirmed < 100);
    assert(existsSync(resolve(data, 'requests', `${createHash('sha256').update('normal').digest('hex')}.json`)));
    await client('shutdown');
    const end = Date.now() + 6000;
    while (!exited && Date.now() < end) await pause(30);
    assert(exited, 'backend did not exit');
    assert.equal(server.exitCode, 0, errors);
    assert(output.includes('"handoffComplete":true'));
    assert.equal(readFileSync(resolve(data, 'worker-audit.jsonl'), 'utf8').trim().split('\n').length, 2);
  } finally {
    if (!exited && existsSync(resolve(data, 'connection.json'))) await client('shutdown').catch(() => {});
    const end = Date.now() + 6000;
    while (!exited && Date.now() < end) await pause(30);
    if (!exited) server.kill();
    writeFileSync(resolve(data, 'backend.log'), output);
    writeFileSync(resolve(data, 'backend.stderr.log'), errors);
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';

test('explicit MuMu config resolves ADB and rejects ambiguous targets without connecting', t => {
  const directory = mkdtempSync(join(tmpdir(), 'chatmaa-connection-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'MaaCore.dll'), 'fixture');
  writeFileSync(join(directory, 'adb.exe'), 'fixture');
  const connection = { kind: 'mumu', adb: 'adb.exe', address: '127.0.0.1:16384', config: 'MuMuEmulator12' };
  const raw = { mode: 'maa-live', installation: directory, connection };
  const file = join(directory, 'config.json');
  const config = loadConfig(file, raw);
  assert.equal(config.connection?.adb, join(directory, 'adb.exe'));
  assert.equal(config.hwnd, undefined);
  assert.equal(loadConfig(file, { mode: 'maa-live', installation: directory, hwnd: 123 }).hwnd, 123);
  for (const value of [{ ...raw, hwnd: 1 }, { ...raw, connection: [] },
    ...['127.0.0.1:0', '127.0.0.1:65536', 'localhost:16384', '127.0.0.1:1;cmd'].map(address =>
      ({ ...raw, connection: { ...connection, address } }))]) {
    assert.throws(() => loadConfig(file, value));
  }
});

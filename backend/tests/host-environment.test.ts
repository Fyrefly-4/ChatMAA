import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { adapterEnvironment } from '../src/host.ts';
import { repository } from '../src/config.ts';

test('Python child receives no casing of model credential while ordinary environment survives', () => {
  const source = { ...process.env, DEEPSEEK_API_KEY: 'synthetic-upper',
    DeepSeek_Api_Key: 'synthetic-mixed', deepseek_api_key: 'synthetic-lower',
    CHATMAA_MODEL_API_KEY: 'new-upper', ChatMaa_Model_Api_Key: 'new-mixed',
    OPENAI_API_KEY: 'ambient-key', CHATMAA_MODEL_ID: 'chosen-model', CHATMAA_ENV_PROBE: 'retained' };
  const env = adapterEnvironment(source);
  assert(!Object.keys(env).some(key => ['DEEPSEEK_API_KEY', 'CHATMAA_MODEL_API_KEY', 'OPENAI_API_KEY'].includes(key.toUpperCase())));
  assert.equal(env.CHATMAA_MODEL_ID, 'chosen-model');
  assert.equal(source.DeepSeek_Api_Key, 'synthetic-mixed');
  const child = spawnSync(resolve(repository, 'adapter/maa/.venv/Scripts/python.exe'), ['-S', '-c',
    'import os,json; print(json.dumps({"key_present": any(k.upper() in ("DEEPSEEK_API_KEY","CHATMAA_MODEL_API_KEY","OPENAI_API_KEY") for k in os.environ), "probe": os.environ.get("CHATMAA_ENV_PROBE")}))'],
  { env, encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { key_present: false, probe: 'retained' });
});

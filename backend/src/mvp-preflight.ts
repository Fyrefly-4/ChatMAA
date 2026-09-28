import { checkDemoFiles } from './demo.ts';
import { loadConfig, repository, withoutModelCredentials } from './config.ts';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function checkMvpEnvironment(configFile?: string) {
  checkDemoFiles();
  const config = loadConfig(configFile);
  const expected = readFileSync(resolve(repository, '.python-version'), 'utf8').trim();
  const version = execFileSync(config.python, ['-c', 'import platform,struct,fastapi,uvicorn; assert struct.calcsize("P")==8; print(platform.python_version())'],
    { encoding: 'utf8', windowsHide: true, timeout: 10000, env: withoutModelCredentials(process.env) }).trim();
  if (version !== expected) throw new Error(`Python 需要 ${expected}，当前 ${version}`);
  return config;
}

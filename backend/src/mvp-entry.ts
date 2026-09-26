import { checkDemoFiles } from './demo.ts';
import { loadConfig } from './config.ts';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { repository, withoutModelCredentials } from './config.ts';

try {
  checkDemoFiles();
  const config = loadConfig();
  const expected = readFileSync(resolve(repository, '.python-version'), 'utf8').trim();
  const version = execFileSync(config.python, ['-c', 'import platform,struct,fastapi,uvicorn; assert struct.calcsize("P")==8; print(platform.python_version())'],
    { encoding: 'utf8', windowsHide: true, timeout: 10000, env: withoutModelCredentials(process.env) }).trim();
  if (version !== expected) throw new Error(`Python 需要 ${expected}，当前 ${version}`);
  await import('./main.ts');
} catch (error) {
  console.error(`MVP 启动失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

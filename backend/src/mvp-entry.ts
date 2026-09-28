import { checkMvpEnvironment } from './mvp-preflight.ts';

try {
  checkMvpEnvironment();
  await import('./main.ts');
} catch (error) {
  console.error(`MVP 启动失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

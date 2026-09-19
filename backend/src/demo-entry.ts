import { checkDemoFiles } from './demo.ts';
// Run dependency checks before importing the application's third-party modules.
try {
  checkDemoFiles();
  await import('./main.ts');
} catch (error) {
  console.error(`Demo 启动失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

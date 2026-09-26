import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { repository } from '../src/config.ts';

test('启动器只读发现：错误程序路径、多实例、损坏配置及端口边界', () => {
  execFileSync(resolve(repository, 'adapter/maa/.venv/Scripts/python.exe'),
    [resolve(repository, 'scripts/launcher/test_discovery.py')], { windowsHide: true, timeout: 10000 });
});

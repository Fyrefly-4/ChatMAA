import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

export const repository = resolve(import.meta.dirname, '../..');
export type Config = {
  mode: 'maa-replay' | 'maa-live'; python: string; dataDir: string; port: number;
  pollMs: number; httpTimeoutMs: number; leaseMs: number; stopDeadlineMs: number;
  installation?: string; hwnd?: number;
};
export function loadConfig(path = process.env.CHATMAA_CONFIG, values?: unknown): Config {
  const local = resolve(repository, 'backend/config.local.json');
  const file = path ? resolve(path) : existsSync(local) ? local : undefined;
  const raw = values ?? (file ? JSON.parse(readFileSync(file, 'utf8')) : {});
  const base = file ? dirname(file) : resolve(repository, 'backend');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('配置必须是 JSON 对象');
  const allowed = ['mode', 'python', 'dataDir', 'port', 'pollMs', 'httpTimeoutMs', 'leaseMs', 'stopDeadlineMs', 'installation', 'hwnd'];
  if (Object.keys(raw).some(k => !allowed.includes(k))) throw new Error('配置含未知字段');
  const mode = raw.mode ?? 'maa-replay';
  if (!['maa-replay', 'maa-live'].includes(mode)) throw new Error('不支持的执行模式');
  function integer(key: string, fallback: number, min = 1, max = 2_147_483_647) {
    const value = raw[key] ?? fallback;
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`无效配置：${key}`);
    return value as number;
  }
  function configuredPath(key: string, fallback: string) {
    const value = raw[key] ?? fallback;
    if (typeof value !== 'string' || !value) throw new Error(`无效路径：${key}`);
    return resolve(base, value);
  }
  const dataDir = configuredPath('dataDir', resolve(repository, mode === 'maa-live' ? '.artifacts/live' : '.artifacts/replay'));
  if (mode === 'maa-live' && dataDir !== resolve(repository, '.artifacts/live') &&
      !(basename(dataDir) === 'data' && basename(dirname(dataDir)).startsWith('run-') &&
        dirname(dirname(dataDir)) === resolve(repository, '.artifacts/live-wizard'))) {
    throw new Error('live dataDir 须为默认目录或本地向导的 run-*/data');
  }
  const config: Config = {
    mode, python: configuredPath('python', resolve(repository, 'adapter/maa/.venv/Scripts/python.exe')),
    dataDir,
    port: integer('port', 0, 0, 65535), pollMs: integer('pollMs', 200), httpTimeoutMs: integer('httpTimeoutMs', 2000),
    leaseMs: integer('leaseMs', 10000), stopDeadlineMs: integer('stopDeadlineMs', 20000),
  };
  if (config.leaseMs <= config.pollMs * 3 || config.stopDeadlineMs < config.httpTimeoutMs * 2) {
    throw new Error('租约须大于三个续期间隔；退出窗口须至少容纳两次 HTTP 等待');
  }
  if (mode === 'maa-live') {
    if (typeof raw.installation !== 'string' || !raw.installation || !Number.isSafeInteger(raw.hwnd) || raw.hwnd <= 0) {
      throw new Error('live 必须显式配置 installation 和 hwnd');
    }
    config.installation = resolve(base, raw.installation); config.hwnd = raw.hwnd;
    if (!existsSync(resolve(config.installation!, 'MaaCore.dll'))) throw new Error('找不到配置的 MaaCore.dll');
  }
  return config;
}

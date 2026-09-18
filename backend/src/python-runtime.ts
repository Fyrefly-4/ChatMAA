import { spawnSync } from 'node:child_process';

export function pythonRuntime(venvPython: string): { executable: string; site: string } {
  const probe = spawnSync(venvPython, ['-c',
    'import json,sys,sysconfig; print(json.dumps({"executable":sys._base_executable,"site":sysconfig.get_paths()["purelib"]}))'],
  { encoding: 'utf8', windowsHide: true, timeout: 8000 });
  if (probe.error || probe.status !== 0) throw new Error(`Python runtime probe failed: ${probe.error ?? probe.stderr}`);
  return JSON.parse(probe.stdout);
}

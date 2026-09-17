import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function latest(prefix: string, file: string) {
  const directory = readdirSync('.artifacts').filter(name => name.startsWith(prefix) && existsSync(join('.artifacts', name, file))).sort().at(-1);
  if (!directory) throw new Error(`找不到 ${prefix} 实验`);
  return JSON.parse(readFileSync(join('.artifacts', directory, file), 'utf8'));
}
const merge = latest('merge-', 'results.json');
const handoff = latest('handoff-', 'handoff-result.json');
const regression = JSON.parse(readFileSync(JSON.parse(readFileSync('.artifacts/latest.json', 'utf8')).path, 'utf8'));
function view(value: any) {
  if (!value) return null;
  return Object.fromEntries(['seq', 'state', 'confirmed', 'certainty', 'device', 'reason', 'automation_stopped',
    'started_cycles', 'unsettled_cycles', 'stop_requested', 'cursor', 'gap'].filter(key => key in value).map(key => [key, value[key]]));
}
const summary = {
  run_id: merge.runId, mode: merge.mode, real_maa_invoked: false,
  meaning: '真实回调脱敏后离线重放；多周期及故障为合成。通过不等于实机合并验证通过。',
  tests: merge.results.map((result: any) => ({ name: result.name, status: result.status,
    duration_ms: result.duration_ms, worker_entries: result.worker_entries, no_leftovers: result.no_leftovers,
    final: view(result.evidence?.final ?? result.evidence?.task ?? result.evidence),
    business: result.databases?.business.tasks.map((row: any) => view({ ...JSON.parse(row.snapshot), cursor: row.cursor, gap: !!row.gap })),
    executor: result.databases?.executor.executions.map((row: any) => view(JSON.parse(row.snapshot))),
    error: result.error, cleanup_error: result.cleanup_error,
  })),
  handoff_rehearsal: { mode: handoff.mode, stopCause: handoff.stopCause, stopScenarioObserved: handoff.stopScenarioObserved,
    shutdownConfirmed: handoff.shutdownConfirmed, failure: handoff.failure, final: view(handoff.final) },
  lifecycle_regression: { run_id: regression.runId, passed: regression.results.filter((r: any) => r.status === 'passed').length,
    total: regression.results.length, meaning: '包括原有组合故障监督缺口的再现，不代表该缺口已解决。' },
  discovered_and_fixed: '停止前发出的轮询晚到曾覆盖停止中状态；TS 现在单独保留停止意图，并有确定性回归检查。',
};
writeFileSync('../maa/evidence/http-merge-offline.json', JSON.stringify(summary, null, 2) + '\n');
console.log(`已导出 ${merge.runId} 的脱敏摘要`);

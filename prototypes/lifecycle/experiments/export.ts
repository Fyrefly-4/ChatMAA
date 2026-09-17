import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const latest = JSON.parse(readFileSync('.artifacts/latest.json', 'utf8'));
const report = JSON.parse(readFileSync(latest.path, 'utf8'));
const { results, ...environment } = report;
const summary = { ...environment, real_maa_invoked: false,
  meaning: 'passed 表示该实验的断言成立；known_gap 和 comparison 实验验证限制，不表示已经提供相应故障兜底。',
  experiments: results.map((r: any) => ({ name: r.name, status: r.status, duration_ms: r.duration_ms,
    limitation: r.limitation, error: r.error, cleanup_error: r.cleanup_error,
    start_observations: r.oracle.filter((e: any) => e.kind === 'start').length,
    success_observations: r.oracle.filter((e: any) => e.kind === 'success').length,
    final_tasks: r.snapshots.at(-1)?.databases.flatMap((d: any) => (d.business?.tasks ?? []).map((t: any) => ({
      database: d.index, id: t.id, cursor: t.cursor, gap: !!t.gap, ...JSON.parse(t.snapshot),
    }))),
  })) };
const selected = results.filter((r: any) => [
  '07_python_crash_after_start', '08_ts_crash_before_projection_commit',
  '14_both_unresponsive_known_gap', '18_windows_default_spawn_comparison',
].includes(r.name)).map((r: any) => ({ name: r.name, status: r.status, limitation: r.limitation,
  oracle: r.oracle, timeline: r.timeline, snapshots: r.snapshots,
}));
mkdirSync('evidence', { recursive: true });
writeFileSync('evidence/summary.json', JSON.stringify(summary, null, 2) + '\n');
writeFileSync('evidence/selected.json', JSON.stringify({ runId: report.runId, experiments: selected }, null, 2) + '\n');
console.log(`Exported evidence from ${report.runId} to ${resolve('evidence')}`);

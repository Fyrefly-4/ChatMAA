import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { checks } from './plan.mjs';

export function evaluateGate(needs, cancelled = false) {
  const errors = [];
  if (cancelled) errors.push('工作流已取消');
  if (needs?.plan?.result !== 'success') errors.push('调度器未成功');
  let plan;
  try { plan = JSON.parse(needs?.plan?.outputs?.plan); } catch { errors.push('执行计划缺失或无效'); }
  if (plan?.version !== 1 || !plan.selected ||
      Object.keys(plan.selected).length !== checks.length ||
      !checks.every(check => typeof plan.selected[check] === 'boolean')) {
    errors.push('执行计划不完整或版本不支持');
  } else {
    for (const check of checks) {
      const result = needs?.[check]?.result;
      if (plan.selected[check] ? result !== 'success' : result !== 'skipped') {
        errors.push(`${check}：计划${plan.selected[check] ? '运行' : '跳过'}，实际 ${result ?? '缺失'}`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = evaluateGate(JSON.parse(process.env.CI_NEEDS), process.env.CI_CANCELLED === 'true');
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `## 检查汇总\n\n${result.ok ? '所选检查全部成功，未选检查按计划跳过。' : result.errors.map(error => `- ${error}`).join('\n')}\n`);
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}

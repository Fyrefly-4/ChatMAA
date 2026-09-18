import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const policy = JSON.parse(readFileSync(new URL('./policy.json', import.meta.url), 'utf8'));
export const checks = policy.checks;

function plan(selected, reasons, fallback = false) {
  return { version: 1, selected: Object.fromEntries(checks.map(check => [check, selected.includes(check)])), reasons, fallback };
}
export function fullPlan(reason, fallback = false) { return plan(checks, [reason], fallback); }

export function selectPaths(paths) {
  if (!paths.length) return fullPlan('差异为空，保守运行全套', true);
  const selected = new Set();
  const reasons = [];
  for (const path of [...new Set(paths)]) {
    if (typeof path !== 'string' || !path || path.startsWith('/') || path.split('/').includes('..')) {
      return fullPlan('差异路径无效，保守运行全套', true);
    }
    if (policy.documentationFiles.includes(path) ||
        policy.documentationDirectories.some(prefix => path.startsWith(prefix) && path.endsWith('.md'))) {
      reasons.push(`${path}：纯说明文档`);
      continue;
    }
    const matched = policy.rules.filter(rule => rule.file === path || (rule.prefix && path.startsWith(rule.prefix)));
    const affected = matched.length ? [...new Set(matched.flatMap(rule => rule.checks))] : checks;
    affected.forEach(check => selected.add(check));
    reasons.push(`${path}：${affected.join(', ')}${matched.length ? '' : '（公共配置或未分类路径）'}`);
  }
  return plan([...selected], reasons);
}

// Git -z keeps spaces, tabs, newlines and non-ASCII names unambiguous.
export function parseDiff(raw) {
  if (!raw) return [];
  const tokens = raw.split('\0');
  if (tokens.pop() !== '') throw new Error('差异数据不完整');
  const paths = [];
  while (tokens.length) {
    const status = tokens.shift();
    if (!/^(?:[AMDT]|[RC]\d+)$/.test(status)) throw new Error(`无法识别差异状态：${status}`);
    const count = /^[RC]/.test(status) ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const path = tokens.shift();
      if (!path) throw new Error('差异路径缺失');
      paths.push(path);
    }
  }
  return paths;
}

export function pullRequestPlan(base, head, cwd = process.cwd()) {
  try {
    if (![base, head].every(sha => /^[0-9a-f]{40}$/.test(sha ?? ''))) throw new Error('无有效比较基线');
    const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    const ancestor = git(['merge-base', base, head]).trim();
    return selectPaths(parseDiff(git(['diff', '--no-ext-diff', '--name-status', '-z', '--find-renames', ancestor, head, '--'])));
  } catch (error) {
    // Error details may contain untrusted filenames; do not write them as workflow commands.
    return fullPlan(`无法可靠读取完整 PR 差异，回退全套（${error.code ?? 'diff-unavailable'}）`, true);
  }
}

export function manualPlan(inputs) {
  if (inputs.mode === 'full') return fullPlan('手动 full');
  if (inputs.mode !== 'custom') throw new Error('手动模式必须为 full 或 custom');
  const selected = checks.filter(check => inputs[check] === true || inputs[check] === 'true');
  if (!selected.length) throw new Error('custom 至少选择一项检查');
  return plan(selected, ['手动 custom：只用于局部验证，不替代 PR 门禁']);
}

export function writePlan(value) {
  if (!process.env.GITHUB_OUTPUT) throw new Error('缺少 GITHUB_OUTPUT');
  appendFileSync(process.env.GITHUB_OUTPUT, `plan=${JSON.stringify(value)}\n` +
    checks.map(check => `${check}=${value.selected[check]}\n`).join(''));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `## 检查计划\n\n<pre>${escape(JSON.stringify(value, null, 2))}</pre>\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  let value;
  switch (process.env.GITHUB_EVENT_NAME) {
    case 'pull_request': value = pullRequestPlan(event.pull_request?.base?.sha, event.pull_request?.head?.sha); break;
    case 'push': value = fullPlan('默认分支提交：全套离线检查'); break;
    case 'workflow_dispatch': value = manualPlan(event.inputs ?? {}); break;
    default: throw new Error('不支持的 CI 事件');
  }
  writePlan(value);
}

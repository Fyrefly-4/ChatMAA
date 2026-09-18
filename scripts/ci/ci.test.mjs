import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checks, fullPlan, manualPlan, parseDiff, pullRequestPlan, selectPaths } from './plan.mjs';
import { evaluateGate } from './gate.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const selected = value => checks.filter(check => value.selected[check]);

for (const [paths, expected] of [
  [['backend/src/host.ts'], ['backend-types', 'backend-tests']],
  [['backend/package-lock.json'], ['backend-types', 'backend-tests']],
  [['adapter/maa/core.py'], ['backend-tests', 'adapter-tests']],
  [['adapter/maa/fixtures/new.json'], ['backend-tests', 'adapter-tests']],
  [['adapter/maa/requirements.lock'], ['backend-tests', 'adapter-tests']],
  [['README.md', 'docs/engineering/ci-plan.md', 'backend/README.md', 'adapter/maa/README.md', 'scripts/ci/README.md'], []],
  [['README.md', 'backend/src/app.ts'], ['backend-types', 'backend-tests']],
  [['backend/prompts/system.md'], ['backend-types', 'backend-tests']],
  [['.github/workflows/check-adapter-tests.yml'], ['adapter-tests']],
  [['.github/workflows/check-backend-types.yml'], ['backend-types']],
  [['.github/workflows/check-backend-tests.yml'], ['backend-tests']],
  [['.github/workflows/ci.yml'], checks],
  [['.github/actions/setup-python/action.yml'], checks],
  [['scripts/ci/policy.json'], checks],
  [['.python-version'], checks],
  [['docs/agents/documentation.md'], checks],
  [['shared/task-contract.json'], checks],
  [['future-module/new.ts'], checks],
  [['docs/engineering/runtime.json'], checks],
]) test(`选择范围：${paths.join(', ')}`, () => assert.deepEqual(selected(selectPaths(paths)), expected));

test('空差异和无效路径回退全套', () => {
  for (const paths of [[], ['../backend/a.ts'], ['/tmp/a.ts'], ['']]) {
    const value = selectPaths(paths);
    assert.deepEqual(selected(value), checks);
    assert.equal(value.fallback, true);
  }
});

test('大 PR 只限制原因摘要，末尾代码改动仍参与选择', () => {
  const paths = Array.from({ length: 1000 }, (_, i) => `docs/archive/${i}.md`);
  paths.push('adapter/maa/core.py');
  const value = selectPaths(paths);
  assert.deepEqual(selected(value), ['backend-tests', 'adapter-tests']);
  assert.equal(value.reasons.length, 61);
  assert.ok(JSON.stringify(value).length < 10000);
});

test('Git NUL 格式处理删除、重命名、特殊路径及截断', () => {
  assert.deepEqual(parseDiff('D\0adapter/maa/deleted.py\0R100\0backend/src/a.ts\0docs/archive/a.md\0'),
    ['adapter/maa/deleted.py', 'backend/src/a.ts', 'docs/archive/a.md']);
  assert.deepEqual(parseDiff('A\0backend/a\tb\n中文.ts\0'), ['backend/a\tb\n中文.ts']);
  for (const broken of ['A\0file', 'R100\0old\0', 'Z\0file\0', 'M\0\0']) assert.throws(() => parseDiff(broken));
});

test('使用完整多提交 PR 差异，保留重命名前路径和删除影响', t => {
  const dir = mkdtempSync(join(tmpdir(), 'chatmaa-ci-git-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (path, content) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), content); };
  const commit = message => { git('add', '.'); git('commit', '-m', message); return git('rev-parse', 'HEAD'); };
  git('init'); git('config', 'user.name', 'CI Test'); git('config', 'user.email', 'ci-test@example.invalid');
  write('README.md', 'base'); write('backend/a.ts', 'export const a = 1;'); write('adapter/maa/delete.py', 'pass');
  const base = commit('base');
  write('backend/a.ts', 'export const a = 2;'); commit('backend change');
  write('README.md', 'docs at latest commit'); const head = commit('docs only last commit');
  assert.deepEqual(selected(pullRequestPlan(base, head, dir)), ['backend-types', 'backend-tests']);
  const beforeRename = head;
  mkdirSync(join(dir, 'docs/archive'), { recursive: true });
  renameSync(join(dir, 'backend/a.ts'), join(dir, 'docs/archive/a.md'));
  const renamed = commit('move source to docs');
  assert.deepEqual(selected(pullRequestPlan(beforeRename, renamed, dir)), ['backend-types', 'backend-tests']);
  rmSync(join(dir, 'adapter/maa/delete.py'));
  const removed = commit('delete adapter');
  assert.deepEqual(selected(pullRequestPlan(renamed, removed, dir)), ['backend-tests', 'adapter-tests']);
  assert.equal(pullRequestPlan('0'.repeat(40), removed, dir).fallback, true);
  assert.equal(pullRequestPlan(undefined, removed, dir).fallback, true);
});

test('手动 full/custom 支持布尔和事件字符串，拒绝空选择', () => {
  assert.deepEqual(selected(manualPlan({ mode: 'full' })), checks);
  assert.deepEqual(selected(manualPlan({ mode: 'custom', 'backend-types': true, 'adapter-tests': 'true' })), ['backend-types', 'adapter-tests']);
  assert.throws(() => manualPlan({ mode: 'custom', 'backend-tests': 'false' }));
  assert.throws(() => manualPlan({ mode: 'auto' }));
});

const results = value => ({ plan: { result: 'success', outputs: { plan: JSON.stringify(value) } },
  ...Object.fromEntries(checks.map(check => [check, { result: value.selected[check] ? 'success' : 'skipped' }])) });

test('所有有效检查组合可汇总，必要检查失败、取消、缺失、跳过均阻断', () => {
  for (let mask = 0; mask < 8; mask++) {
    const value = fullPlan('test');
    checks.forEach((check, index) => { value.selected[check] = Boolean(mask & (1 << index)); });
    assert.equal(evaluateGate(results(value)).ok, true);
    assert.equal(evaluateGate(results(value), true).ok, false);
    for (const check of checks.filter(check => value.selected[check])) {
      for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
        const needs = results(value); needs[check] = { result };
        assert.equal(evaluateGate(needs).ok, false, `${check}: ${result}`);
      }
    }
  }
});

test('调度器失败、缺失计划、不完整计划及未知版本不能放行', () => {
  for (const status of ['failure', 'cancelled', 'skipped', undefined]) {
    const needs = results(fullPlan('test')); needs.plan.result = status;
    assert.equal(evaluateGate(needs).ok, false);
  }
  for (const raw of [undefined, '', '{}', 'null', '{', JSON.stringify({ version: 1, selected: {} }),
    JSON.stringify({ version: 2, selected: Object.fromEntries(checks.map(check => [check, true])) })]) {
    const needs = results(fullPlan('test')); needs.plan.outputs.plan = raw;
    assert.equal(evaluateGate(needs).ok, false);
  }
});

test('真实 CLI 写入可解析计划，gate 进程失败返回非零，空 custom 不产生计划', t => {
  const dir = mkdtempSync(join(tmpdir(), 'chatmaa-ci-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const event = join(dir, 'event.json'), output = join(dir, 'output'), summary = join(dir, 'summary');
  writeFileSync(event, JSON.stringify({ inputs: { mode: 'custom', 'backend-types': 'true' } }));
  const env = { ...process.env, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary };
  const run = (script, overrides = {}) => spawnSync(process.execPath, [resolve(root, 'scripts/ci', script)], { cwd: root, env: { ...env, ...overrides }, encoding: 'utf8' });
  assert.equal(run('plan.mjs').status, 0);
  const value = JSON.parse(readFileSync(output, 'utf8').split('\n')[0].slice('plan='.length));
  assert.deepEqual(selected(value), ['backend-types']);
  const needs = results(value);
  assert.equal(run('gate.mjs', { CI_NEEDS: JSON.stringify(needs) }).status, 0);
  needs['backend-types'].result = 'failure';
  assert.equal(run('gate.mjs', { CI_NEEDS: JSON.stringify(needs) }).status, 1);
  writeFileSync(event, JSON.stringify({ inputs: { mode: 'custom' } }));
  rmSync(output);
  assert.notEqual(run('plan.mjs').status, 0);
  assert.throws(() => readFileSync(output));
});

// 显式真实模型验收入口；不被默认 test/CI 调用，执行端固定为正式回放。
import assert from 'node:assert/strict';
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { repository } from '../config.ts';
import { startHost } from '../host.ts';
import { deepseekModel } from './provider.ts';
import { AgentRequests } from './requests.ts';

const model = deepseekModel();
const dataDir = resolve(repository, '.artifacts/agent-verification', `run-${Date.now()}`);
mkdirSync(dataDir, { recursive: true });
const host = await startHost({ mode: 'maa-replay', dataDir,
  python: resolve(repository, 'adapter/maa/.venv/Scripts/python.exe'), port: 0,
  pollMs: 100, httpTimeoutMs: 2000, leaseMs: 10000, stopDeadlineMs: 10000 });
const agent = new AgentRequests(host.tasks, model);
let scenarioChecksPassed = false;
try {
  const originals = ['帮我刷 1-7 十次', '你能刷 1-7 吗？', '帮我刷 1-7', '帮我刷 1-7 十次，允许吃药'];
  for (const [index, original] of originals.entries()) {
    const view = await agent.handle({ requestId: `sample-${index + 1}`, original }, async event => {
      // 摘要先实际写入本地调试输出，回调完成后工具才提交。
      await new Promise<void>((ok, fail) => process.stdout.write(`${JSON.stringify(event)}\n`, error => error ? fail(error) : ok()));
      appendFileSync(resolve(dataDir, 'events.jsonl'), `${JSON.stringify({ requestId: `sample-${index + 1}`, ...event })}\n`);
    });
    writeFileSync(resolve(dataDir, `sample-${index + 1}.json`), JSON.stringify(view, null, 2));
    assert.equal(view.record.status, 'finished', '真实模型请求须完成；失败不自动重试');
    assert(view.record.reply?.trim(), '应有模型解释');
    if (index === 0) {
      assert(view.task, '必须有真实模型产生的工具调用及任务服务受理事实');
      const end = Date.now() + 15000;
      while (host.tasks.get(view.record.operationId).state !== 'ended' && Date.now() < end) await new Promise(r => setTimeout(r, 100));
      const task = host.tasks.get(view.record.operationId);
      assert.equal(task.confirmed, 10); assert.equal(task.certainty, 'exact');
      assert.equal(task.evidence_source, 'offline_callback_replay');
      writeFileSync(resolve(dataDir, 'completed-task.json'), JSON.stringify(task, null, 2));
    } else {
      assert.equal(view.task, null);
      assert(!view.events.some(event => event.kind === 'tool_call'), '不支持的样例不应尝试调用工具');
      assert(!view.events.some(event => event.kind === 'model_tools' && Array.isArray(event.data) && event.data.length > 0),
        '不支持的样例也不应产生被 SDK 拒绝的未知工具调用');
    }
  }
  assert.equal(host.tasks.list().length, 1);
  scenarioChecksPassed = true;
} finally {
  agent.cancelAll();
  const shutdown = await host.close();
  const automaticChecksPassed = scenarioChecksPassed && shutdown.handoffComplete && shutdown.childExited;
  const verification = { automaticChecksPassed, replyReview: 'pending',
    reviewChecklist: [
      '关卡 1-7 与次数范围未混淆，未虚构小次数上限',
      '固定不吃药不碎石无需重复确认；缺项时要求完整重述',
      '推荐示例可被本地规则接受',
      '回复符合当时工具结果，未将受理当作完成，未隐瞒未知或回放来源',
    ], shutdown };
  writeFileSync(resolve(dataDir, 'verification.json'), JSON.stringify(verification, null, 2));
  console.log(JSON.stringify({ kind: 'verification', automaticChecksPassed, replyReview: 'pending', dataDir,
    handoffComplete: shutdown.handoffComplete }));
  if (!shutdown.handoffComplete || !shutdown.childExited) process.exitCode = 1;
}

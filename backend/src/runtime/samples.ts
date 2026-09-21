import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, repository } from '../config.ts';
import { startHost } from '../host.ts';
import { deepseekModel, MODEL_IDENTITY } from '../agent/provider.ts';
import { RuntimeService } from './service.ts';
import { modelRunner } from './loop.ts';
import { INSTRUCTIONS_VERSION } from './instructions.ts';
import { parseArgs } from 'node:util';

// Explicit opt-in driver, never imported by the app or offline tests.
const { values } = parseArgs({ options: { 'allow-model': { type: 'boolean' }, scenario: { type: 'string' } } });
if (!values['allow-model']) throw new Error('此入口调用真实模型；取得授权后显式传 --allow-model。');
const configPath = process.env.CHATMAA_CONFIG;
if (!configPath) throw new Error('请用 CHATMAA_CONFIG 显式指定回放配置');
const rawConfig = JSON.parse(readFileSync(resolve(configPath), 'utf8'));
if (rawConfig.mode !== 'maa-replay') throw new Error('真实模型样例只允许 maa-replay，拒绝 live 配置');
const config = loadConfig(configPath, rawConfig);
if (existsSync(resolve(repository, '.env'))) process.loadEnvFile(resolve(repository, '.env'));
const model = deepseekModel();
const host = await startHost(config, { business: true });
const business = host.business!;
const runtime = new RuntimeService(business, modelRunner(business, model)); runtime.enableFollowups();
const stamp = Date.now();
const directory = resolve(config.dataDir, `model-samples-${stamp}`); mkdirSync(directory, { recursive: true });
const scenarios = [
  { name: 'count', messages: ['刷1-7一次，不吃药不碎石', '为什么选择这一关？', '改成两次直接开始', '按刚展示的方案开始'] },
  { name: 'inventory', messages: ['补到75个', '固源岩', '按刚展示的方案开始'] },
  { name: 'material', messages: ['再获得3个固源岩', '这个是总库存还是新增数量？', '按刚展示的方案开始'] },
  { name: 'limits', messages: ['能不能同时刷两种材料？', '我要吃药刷1-7十次', '如果改成五次会怎样？'] },
  { name: 'unknown', messages: ['固源岩组补到100个', '扫描没识别到是不是等于零？'] },
  { name: 'satisfied', messages: ['把固源岩补到70个', '现在还需要刷吗？'] },
  { name: 'unverified-stage', messages: ['去CE-6再获得3个固源岩', '资料不支持的话先不要执行'] },
  { name: 'paraphrase', messages: ['去1-7打两把，只用现在的理智', '先别开始，改成打一把', '这次按显示的方案执行', '再来一次，先让我看方案'] },
];
const report: { model: typeof MODEL_IDENTITY; instructions: string; mode: string; scenarios: unknown[]; shutdown?: unknown } = {
  model: MODEL_IDENTITY, instructions: INSTRUCTIONS_VERSION, mode: config.mode, scenarios: [] };
const save = () => writeFileSync(resolve(directory, 'evidence.json'), JSON.stringify(report, null, 2));
try {
  const selected = values.scenario?.split(',');
  if (selected?.some(name => !scenarios.some(scenario => scenario.name === name))) throw new Error('unknown_scenario');
  for (const scenario of scenarios.filter(scenario => !selected || selected.includes(scenario.name))) {
    const conversationId = `sample-${scenario.name}-${stamp}`;
    business.createConversation(conversationId, `真实模型回放 ${scenario.name}`);
    const turns: unknown[] = [];
    report.scenarios.push({ name: scenario.name, conversationId, turns });
    for (const [index, original] of scenario.messages.entries()) {
      const turn = runtime.submit(conversationId, `${conversationId}-${index}`, original);
      await runtime.settled(turn.id);
      // Driver waits for replay facts between simulated user inputs; Runtime itself does not poll tools.
      const deadline = Date.now() + 15000;
      while (host.tasks.list().some(task => !['ended', 'rejected'].includes(task.state)) && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 100));
      const snapshot = runtime.conversation(conversationId);
      const plan = snapshot.business.currentPlan ? business.plan(snapshot.business.currentPlan) : null;
      if (plan && ['unpresented', 'presented'].includes(plan.state)) {
        await new Promise<void>((resolve, reject) => process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`, error => error ? reject(error) : resolve()));
        business.present(plan.id, `sample-display-${plan.id}`);
      }
      turns.push({ original, runtime: runtime.read(turn.id), snapshot: runtime.conversation(conversationId) });
      save();
      console.log(`样例 ${scenario.name}/${index + 1}: ${runtime.read(turn.id).turn.state}`);
      if (runtime.read(turn.id).turn.state !== 'completed') break;
    }
    save();
    if (host.tasks.admission().state !== 'ready') break;
  }
} finally {
  await runtime.close(); report.shutdown = await host.close(); save();
  console.log(`样例证据：${resolve(directory, 'evidence.json')}。须人工审阅原文、工具与业务事实，脚本结束不表示验收通过。`);
}

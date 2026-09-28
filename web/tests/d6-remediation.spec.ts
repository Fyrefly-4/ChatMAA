import { test, expect } from '@playwright/test';
import { presentationPage, sceneData } from './mvp-presentation';
import { newRequest } from '../../backend/src/business/request-lifecycle';

test('无方案的未知成果调整有旧任务入口并可取消，刷新不复活', async ({ page }) => {
  const d = sceneData('adjust');
  d.conversation.currentPlan = null; d.conversation.plan = null;
  d.messages = d.messages.filter(m => m.reference !== 'plan');
  d.conversation.request = { ...newRequest('request', 'chat', 'message', { kind: 'count', quantity: 1, stage: '1-7' }),
    waiting: ['previous_result_uncertain'], adjustment: 'total', previousTasks: ['task'] };
  d.conversation.waitingGuidance = { requestId: 'request', revision: 1, canCancel: true, taskIds: ['task'], environment: 'ready',
    message: '旧成果不能精确核算。环境检查或重启不会补齐旧成果。可取消本次调整，或明确提出独立的新目标。' };
  await presentationPage(page, d);
  let cancelled = 0;
  await page.route('**/api/requests/request/cancel', async route => {
    expect(route.request().postDataJSON()).toEqual({ revision: 1 }); cancelled++;
    d.conversation.request!.state = 'cancelled'; d.conversation.request!.waiting = [];
    d.conversation.waitingGuidance = null; await route.fulfill({ json: d.conversation.request });
  });
  const wait = page.getByRole('region', { name: '待处理需求' });
  await expect(wait.getByText(/不会补齐/)).toBeVisible();
  await wait.getByRole('button', { name: '查看旧任务结果' }).click();
  await expect(page.getByRole('complementary', { name: '详情' })).toBeVisible();
  await wait.getByRole('button', { name: '取消本次调整' }).click();
  await expect(wait).toHaveCount(0); await page.reload(); await expect(wait).toHaveCount(0);
  expect(cancelled).toBe(1);
});

test('运行下界明确为已确认量；精确结束显示共同摘要且刷新不重复', async ({ page }) => {
  const d = sceneData('running');
  d.task.plan!.goal = { kind: 'count', quantity: 3, stage: '2-8' }; d.task.plan!.stage = '2-8'; d.task.plan!.quantity = 3;
  d.task.result!.amount = { value: 1, certainty: 'lower_bound' }; d.task.result!.remaining = null;
  d.task.task.unsettled_cycles = 1;
  await presentationPage(page, d);
  const card = page.getByRole('region', { name: '刷图任务', exact: true });
  await expect(card.getByRole('heading', { name: '目标：2-8 · 成功完成 3 次' })).toBeVisible();
  await expect(card.getByText('已确认成功次数')).toBeVisible();
  await expect(card.getByText(/最终数量以结束反馈为准/)).toBeVisible();
  await expect(card.getByText(/1 个批次尚未结算/)).toBeVisible();
  await expect(card.getByText(/最近成功同步/)).toBeVisible();
  for (const value of [2, 3]) { d.task.result!.amount.value = value; d.task.task.seq++; await expect(card.locator('.m-metrics strong').first()).toHaveText(String(value)); }
  d.task.task.state = 'ended'; d.task.task.automation_stopped = true; d.task.task.seq++;
  d.task.result!.process = 'succeeded'; d.task.result!.amount.certainty = 'exact';
  d.task.summary = '任务已完成；本次已确认3次；目标已达成；剩余0。';
  await expect(card.getByText(d.task.summary)).toBeVisible();
  await expect(card.getByText(/仍在等待执行反馈/)).toHaveCount(0);
  await page.reload(); await expect(card).toHaveCount(1); await expect(card.getByText(d.task.summary)).toBeVisible();
});

test('失败交接引用已有方案时不重复展示确认卡；扫描与检查显示真实计时', async ({ page }) => {
  const d = sceneData('plan');
  d.messages.push({ id: 'handoff', conversationId: 'chat', role: 'system', text: '本轮回复未完成，请查看当前方案。', reference: d.plan.id, createdAt: d.plan.createdAt });
  await presentationPage(page, d);
  await expect(page.getByRole('region', { name: '执行方案 1' })).toHaveCount(1);
});

test('扫描、停止和检查显示阶段时间，未知旧时间不虚构', async ({ page }) => {
  const d = sceneData('scan'); d.task.startedAt = Date.now() / 1000 - 8;
  d.status.recovery = { ...d.status.recovery, state: 'checking', message: '正在检查画面。', startedAt: Date.now() / 1000 - 4, actions: ['cancel'] };
  await presentationPage(page, d);
  const card = page.getByRole('region', { name: '库存扫描任务' });
  await expect(card.getByText(/正在扫描库存/)).toBeVisible();
  await expect(card.getByText(/扫描任务已持续/)).toBeVisible();
  await expect(page.getByRole('region', { name: '恢复使用' }).getByText(/检查已持续/)).toBeVisible();
  d.task.task.stop_requested = true; d.task.task.state = 'stopping'; d.task.task.seq++;
  await expect(card.getByText(/已请求停止/)).toBeVisible();
  await expect(card.getByText(/停止请求起始时间未记录/)).toBeVisible();
});

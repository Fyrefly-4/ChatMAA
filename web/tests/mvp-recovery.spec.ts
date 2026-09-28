import { test, expect } from '@playwright/test';
import { presentationPage, sceneData } from './mvp-presentation';

test('恢复入口由后端动作驱动：准备画面、检查失败、重试与停止未确认', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(crypto, 'randomUUID', { value: () => 'fixture-check' }); });
  const data = sceneData('running');
  data.task.task.state = 'ended'; data.task.task.automation_stopped = true; data.task.task.device = 'needs_check';
  data.status.recovery = { state: 'needs_check', message: '自动化已停止。请回到首页或关卡准备页。', actions: ['check'], target: 'task', taskIds: ['task'], lastCheck: null, device: null, startedAt: null };
  await presentationPage(page, data);
  let calls = 0;
  await page.route('**/api/recovery', async route => {
    calls++; expect(route.request().postDataJSON().action).toBe('check');
    data.status.recovery = { ...data.status.recovery, state: 'checking', message: '正在检查，不会刷图。', actions: ['cancel'] };
    await route.fulfill({ json: data.status.recovery });
  });
  const region = page.getByRole('region', { name: '恢复使用' });
  await expect(region.getByText(/首页或关卡准备页/)).toBeVisible();
  const check = region.getByRole('button', { name: '我已准备好，检查环境' });
  await expect(check).toBeDisabled();
  await region.getByRole('checkbox').check(); await check.click();
  await expect(region.getByRole('button', { name: '取消检查' })).toBeVisible();
  await page.reload(); await expect(region.getByRole('button', { name: '取消检查' })).toBeVisible();
  expect(calls).toBe(1);
  data.status.recovery = { ...data.status.recovery, state: 'needs_check', actions: ['check'],
    lastCheck: { id: 'failed', state: 'ended', automation_stopped: true, ready: false } };
  await expect(region.getByText(/上次未识别到可用画面/)).toBeVisible();
  await expect(check).toBeDisabled();
  data.status.recovery = { ...data.status.recovery, state: 'unconfirmed', actions: ['reconnect'], message: '停止尚未确认，请重新连接。' };
  await expect(region.getByRole('button', { name: '结束本次执行服务并重新连接' })).toBeVisible();
  await expect(check).toHaveCount(0);
  expect(calls).toBe(1);
});

import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { presentationPage, scenarios, sceneData } from './mvp-presentation';

for (const scene of scenarios) test(`V2.1 ${scene} 五种宽度与详情`, async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const data = sceneData(scene); await presentationPage(page, data);
  await expect(page.locator('.mvp')).toBeVisible();
  await expect(page.locator('.m-message-group').first()).toBeVisible();
  const output = resolve(import.meta.dirname, '../../.artifacts/checks/d5-visual'); mkdirSync(output, { recursive: true });
  for (const width of [1440, 1024, 736, 390, 320]) {
    await page.setViewportSize({ width, height: 960 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (data.conversation.currentPlan && ['unpresented', 'presented'].includes(data.plan.state)) {
      const plan = page.locator('.m-plan').first();
      await expect(plan).toHaveCSS('border-top-width', '1px'); await expect(plan).toHaveCSS('border-radius', '12px');
    }
    for (const task of await page.locator('.m-task').all()) await expect(task).toHaveCSS('border-left-width', '0px');
    await page.screenshot({ path: resolve(output, `${scene}-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  if (scene === 'cross') await page.locator('.m-global').getByRole('button', { name: '任务详情' }).click();
  else if (data.conversation.currentPlan) await page.getByRole('button', { name: '查看依据 →' }).first().click();
  else await page.getByRole('button', { name: '查看任务详情 →' }).first().click();
  await expect(page.getByRole('complementary', { name: '详情' })).toBeVisible();
  await page.screenshot({ path: resolve(output, `${scene}-details.png`), fullPage: true });
  await page.getByRole('button', { name: '收起详情' }).click();
  await expect(page.getByRole('button', { name: '查看详情', exact: true })).toBeFocused();
  expect(errors).toEqual([]);
});

test('下界、模型失败、页面连接和业务投影故障分别表达，直接停止仍可达', async ({ page }) => {
  const data = sceneData('unknown'); const calls: string[] = [];
  await presentationPage(page, data, calls);
  await expect(page.getByRole('region', { name: '刷图任务' }).getByText('至少 12', { exact: true })).toBeVisible();
  await expect(page.getByText('剩余目标量', { exact: true })).toHaveCount(0);
  data.status.projection = { available: false, reason: 'business_projection_failed' };
  data.status.runtime.available = false;
  await expect(page.getByText(/业务投影：business_projection_failed/)).toBeVisible();
  await page.locator('.m-global').getByRole('button', { name: '停止任务' }).click();
  await expect.poll(() => calls.filter(c => c === 'POST /api/tasks/task/stop').length).toBe(1);
  await expect(page.getByText('自动化已停止', { exact: true })).toHaveCount(0);
  await page.route('http://chatmaa.test/api/status', route => route.abort());
  await expect(page.getByText(/页面与后台连接中断/)).toBeVisible();
  await expect(page.getByRole('region', { name: '刷图任务' })).toBeVisible();
});

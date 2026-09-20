import { test, expect } from './fixtures';

test.use({ modelMode: 'history' });
test.describe('admission presentation', () => {
test.use({ modelMode: 'normal' });
test('remote recovery success does not enable commands before business evidence is synchronized', async ({ page, server }) => {
  let synchronized = false;
  await page.route('**/api/status', async route => {
    const response = await route.fetch();
    const status = await response.json();
    status.device = { blockers: [], recoverable: false,
      recovery: { id: 'delayed', state: 'succeeded', reason: null, automation_stopped: true },
      admission: { state: synchronized ? 'ready' : 'synchronizing', conflictingTaskIds: synchronized ? [] : ['history'] } };
    status.conflictingTaskIds = status.device.admission.conflictingTaskIds;
    await route.fulfill({ response, json: status });
  });
  await page.goto(server.url);
  await page.getByLabel('完整指令').fill('刷1-7一次');
  await expect(page.getByText('执行端已解除阻塞，正在同步业务证据，暂不能发送新指令。')).toBeVisible();
  await expect(page.getByRole('button', { name: '发送指令' })).toBeDisabled();
  synchronized = true;
  await expect(page.getByText('环境核对通过，可以发送新指令。', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: '发送指令' })).toBeEnabled();
  expect(server.audit()).toHaveLength(0);
  await page.unrouteAll({ behavior: 'wait' });
});
});

test('historical blocker is visible before sending, explicit takeover preserves evidence and never replays commands', async ({ page, server }) => {
  await page.goto(server.url);
  await expect(page.getByRole('heading', { name: '设备暂不能接受新任务' })).toBeVisible();
  await expect(page.getByRole('button', { name: '发送指令' })).toBeDisabled();
  const recover = page.getByRole('button', { name: '核对环境并恢复使用' });
  await expect(recover).toBeDisabled();
  await page.reload();
  expect(server.audit()).toHaveLength(0);
  await page.getByRole('checkbox').check();
  await recover.click();
  await expect(page.getByText('环境核对通过，可以发送新指令。', { exact: false })).toBeVisible();
  await expect(page.getByText('上述次数、停止状态和未知部分仍是旧任务的历史证据。', { exact: false })).toBeVisible();
  expect(server.audit()).toHaveLength(0);
  await page.reload();
  expect(server.audit()).toHaveLength(0);
  await page.getByLabel('完整指令').fill('刷1-7一次');
  await expect(page.getByRole('button', { name: '发送指令' })).toBeEnabled();
  await page.getByRole('button', { name: '发送指令' }).click();
  await expect(page.getByRole('heading', { name: '已确认完成 1/1 次' })).toBeVisible();
  expect(server.audit()).toHaveLength(1);
});

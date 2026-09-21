import { test, expect } from './fixtures';
test.use({ mvp: true });

test('MVP 次数方案修改、按钮确认、结果与刷新不重复执行', async ({ page, server }) => {
  await page.goto(server.url); await page.getByRole('button', { name: '＋ 新会话' }).click();
  const send = async (text: string) => { await page.getByRole('textbox', { name: '消息', exact: true }).fill(text); await page.getByRole('button', { name: '发送', exact: true }).click(); };
  await send('刷1-7两次'); await expect(page.getByRole('button', { name: '确认并开始' })).toBeEnabled();
  expect(server.audit().length).toBe(0);
  await send('改成五次'); await expect(page.getByRole('heading', { name: '1-7 · 成功完成 5 次' })).toBeVisible();
  await page.getByRole('button', { name: '确认并开始' }).click();
  await expect(page.getByRole('region', { name: '刷图任务', exact: true }).getByText('目标已达成', { exact: false })).toBeVisible({ timeout: 15000 });
  expect(server.audit().length).toBe(1);
  await page.reload(); await expect(page.getByRole('region', { name: '刷图任务', exact: true }).getByText('目标已达成', { exact: false })).toBeVisible();
  expect(server.audit().length).toBe(1);
  await page.getByRole('button', { name: '查看任务详情 →' }).click();
  await expect(page.getByRole('heading', { name: '关键记录' })).toBeVisible();
  await expect(page.locator('.m-events li').first()).toBeVisible();
  await page.reload(); await expect(page.getByRole('heading', { name: '关键记录' })).toBeVisible();
  expect(server.audit().length).toBe(1);
});

for (const [text, title, expected] of [['再获得3个固源岩', '固源岩 · 再获得 3 个', 1], ['固源岩补到75个', '固源岩 · 补到 75 个', 2]] as const) {
  test(`MVP ${text} 经实际 Runtime 与正式回放，自然语言确认`, async ({ page, server }) => {
    await page.goto(server.url); await page.getByRole('button', { name: '＋ 新会话' }).click();
    await page.getByRole('textbox', { name: '消息', exact: true }).fill(text); await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByRole('heading', { name: title })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('button', { name: '确认并开始' })).toBeEnabled();
    expect(server.audit().length).toBe(expected - 1);
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('按这个开始'); await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByRole('region', { name: '刷图任务', exact: true }).getByText('目标已达成', { exact: false })).toBeVisible({ timeout: 15000 });
    expect(server.audit().length).toBe(expected);
    if (expected === 2) await expect(page.getByText('推算库存，未重新扫描。', { exact: false })).toBeVisible();
  });
}

test('MVP 跨会话咨询、全局停止、草稿和详情归属', async ({ page, server }) => {
  await page.goto(server.url); await page.getByRole('button', { name: '＋ 新会话' }).click();
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('刷1-7一百次'); await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('button', { name: '确认并开始' }).click();
  await expect(page.locator('.m-global').getByRole('button', { name: '停止任务' })).toBeVisible();
  await page.getByRole('button', { name: '＋ 新会话' }).click();
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('咨询'); await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('可以继续咨询；游戏任务按独立事实更新。')).toBeVisible();
  await page.locator('.m-global').getByRole('button', { name: '任务详情' }).click();
  await expect(page.getByText('正在查看另一个会话的对象。')).toBeVisible();
  await page.locator('.m-global').getByRole('button', { name: '停止任务' }).click();
  await expect(page.locator('.m-details').getByText('自动化已停止', { exact: true })).toBeVisible();
  expect(server.audit().length).toBe(1);
});

test('MVP 消息受理响应丢失，刷新只查询原消息而不重发', async ({ page, server }) => {
  await page.goto(server.url); await page.getByRole('button', { name: '＋ 新会话' }).click();
  let posts = 0;
  await page.route('**/api/messages', async route => { posts++; await route.fetch(); await route.abort(); });
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('刷1-7两次');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('button', { name: '确认并开始' })).toBeEnabled();
  await page.reload(); await expect(page.getByRole('button', { name: '确认并开始' })).toBeEnabled();
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('');
  expect(posts).toBe(1); expect(server.audit().length).toBe(0);
});

test('MVP 确认受理响应丢失，后续读取同一任务不重发确认', async ({ page, server }) => {
  await page.goto(server.url); await page.getByRole('button', { name: '＋ 新会话' }).click();
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('刷1-7两次'); await page.getByRole('button', { name: '发送', exact: true }).click();
  let posts = 0;
  await page.route('**/api/plans/*/confirm', async route => { posts++; await route.fetch(); await route.abort(); });
  await page.getByRole('button', { name: '确认并开始' }).click();
  await expect(page.getByRole('region', { name: '刷图任务', exact: true }).getByText('目标已达成', { exact: false })).toBeVisible();
  await page.reload(); await expect(page.getByRole('region', { name: '刷图任务', exact: true })).toBeVisible();
  expect(posts).toBe(1); expect(server.audit().length).toBe(1);
});

test('MVP 模型失败后保持任务查询与直接停止，草稿按会话保存', async ({ page, server }) => {
  await page.goto(server.url); await page.getByRole('button', { name: '＋ 新会话' }).click();
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('刷1-7一百次'); await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('button', { name: '确认并开始' }).click();
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('模型故障'); await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText(/本轮处理失败/)).toBeVisible();
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('会话一草稿');
  await page.getByRole('button', { name: '＋ 新会话' }).click();
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('');
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('会话二草稿');
  await page.getByRole('navigation').getByRole('button', { name: /^会话 1/ }).click();
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('会话一草稿');
  await page.locator('.m-global').getByRole('button', { name: '停止任务' }).click();
  await expect(page.getByRole('region', { name: '刷图任务', exact: true }).getByText('自动化已停止', { exact: true })).toBeVisible();
  expect(server.audit().length).toBe(1);
});

test.describe('持久历史读取', () => {
  test.use({ modelMode: 'long-history' });
  test('MVP 消息分页和超过100条终态活动读完，历史浏览不执行', async ({ page, server }) => {
    const activityRequests: string[] = [];
    page.on('request', request => { if (request.url().includes('/api/turns/')) activityRequests.push(request.url()); });
    await page.goto(server.url);
    await expect(page.getByText('历史消息 64', { exact: true })).toBeVisible();
    await expect(page.getByText('历史消息 0', { exact: true })).toHaveCount(0);
    await expect.poll(() => activityRequests.some(url => /after=[1-9]/.test(url))).toBe(true);
    for (let i = 0; i < 3; i++) await page.getByRole('button', { name: '加载更早记录' }).click();
    await expect(page.getByText('历史消息 0', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '加载更早记录' })).toHaveCount(0);
    expect(server.audit().length).toBe(0);
  });
});

for (const [text, quantity] of [['总共改成五次', 3], ['再刷五次', 5]] as const) {
  test(`MVP 两次完成后${text}，新方案独立确认并关联旧任务`, async ({ page, server }) => {
    await page.goto(server.url); await page.getByRole('button', { name: '＋ 新会话' }).click();
    const send = async (value: string) => { await page.getByRole('textbox', { name: '消息', exact: true }).fill(value); await page.getByRole('button', { name: '发送', exact: true }).click(); };
    await send('刷1-7两次'); await page.getByRole('button', { name: '确认并开始' }).click();
    await expect(page.getByRole('region', { name: '刷图任务', exact: true }).getByText(/目标已达成/)).toBeVisible();
    await send(text);
    await expect(page.getByRole('heading', { name: `1-7 · 成功完成 ${quantity} 次` })).toBeVisible();
    expect(server.audit().length).toBe(1);
    await page.locator('.m-plan').getByRole('button', { name: '查看依据 →' }).click();
    await expect(page.getByRole('heading', { name: '调整关系' })).toBeVisible();
    await expect(page.getByRole('button', { name: /查看旧任务/ })).toBeVisible();
    await page.getByRole('button', { name: '确认并开始' }).click();
    await expect.poll(() => server.audit().length).toBe(2);
  });
}

test('MVP 扫描库存已足够时不生成零目标刷图', async ({ page, server }) => {
  await page.goto(server.url); await page.getByRole('button', { name: '＋ 新会话' }).click();
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('固源岩补到1个'); await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText(/目标已满足，无需新增刷图/)).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('button', { name: '确认并开始' })).toHaveCount(0);
  expect(server.audit().length).toBe(1);
});

test('MVP 两个标签页同时确认同一方案只受理一个任务', async ({ page, context, server }) => {
  await page.goto(server.url); await page.getByRole('button', { name: '＋ 新会话' }).click();
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('刷1-7两次'); await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('button', { name: '确认并开始' })).toBeEnabled();
  const other = await context.newPage(); await other.goto(server.url);
  await expect(other.getByRole('button', { name: '确认并开始' })).toBeEnabled();
  await Promise.all([page.getByRole('button', { name: '确认并开始' }).click(), other.getByRole('button', { name: '确认并开始' }).click()]);
  for (const tab of [page, other]) await expect(tab.getByRole('region', { name: '刷图任务', exact: true }).getByText(/目标已达成/)).toBeVisible();
  expect(server.audit().length).toBe(1);
  await other.close();
});

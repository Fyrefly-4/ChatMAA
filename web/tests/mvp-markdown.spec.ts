import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { presentationPage, sceneData } from './mvp-presentation';

test('助手 Markdown 排版与窄屏代码，用户输入保留原文', async ({ page }) => {
  const state = sceneData('plan');
  state.messages = [
    { ...state.messages[0], role: 'user', text: '**保持用户原文**', reference: undefined },
    { ...state.messages[1], role: 'assistant', reference: undefined, text: [
      '## 方案说明', '', '**目标**：固源岩补到 *75 个*。', '',
      '- 库存 72 个', '- 缺口 **3 个**', '  - 不吃药、不碎石', '',
      '1. 先查看方案', '2. 再确认执行', '', '> 参考消耗不是当前可用理智。', '',
      '字段 `remaining` 仅用于说明。', '', '```text', 'example='.repeat(90), '```', '',
      '[资料来源](https://example.com/source)',
    ].join('\n') },
  ];
  await presentationPage(page, state);
  const reply = page.locator('.m-markdown');
  await expect(reply.getByRole('heading', { name: '方案说明' })).toBeVisible();
  await expect(reply.locator('strong').first()).toHaveText('目标');
  await expect(reply.locator('ul > li')).toHaveCount(3);
  await expect(reply.locator('ol > li')).toHaveCount(2);
  await expect(reply.locator('blockquote')).toContainText('参考消耗');
  await expect(reply.locator('p code')).toHaveText('remaining');
  await expect(reply.getByRole('link', { name: '资料来源' })).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(page.locator('.m-user')).toHaveText('**保持用户原文**');
  const output = resolve(import.meta.dirname, '../../.artifacts/checks/d5-markdown'); mkdirSync(output, { recursive: true });
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 960 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: resolve(output, `markdown-${width}.png`), fullPage: true });
  }
});

test('模型 HTML、危险链接和图片不执行或自动加载', async ({ page }) => {
  const state = sceneData('plan'); const mediaRequests: string[] = [];
  page.on('request', request => { if (request.url().includes('remote-image.test')) mediaRequests.push(request.url()); });
  state.messages = [{ ...state.messages[1], role: 'assistant', reference: undefined, text: [
    '<script>window.markdownExecuted=true</script>', '',
    '<img src="https://remote-image.test/raw.png" onerror="window.markdownExecuted=true">', '',
    '[危险](javascript:alert%281%29) [编码危险](java&#x73;cript:alert%281%29)', '',
    '[本地操作](/api/tasks/task/stop) [协议相对](//remote-image.test/link)', '',
    '[数据](data:text/html,test) [文件](file:///C:/test)', '',
    '![图片替代文字](https://remote-image.test/markdown.png)', '',
    '[正常链接](https://example.com/)',
  ].join('\n') }];
  await presentationPage(page, state);
  const reply = page.locator('.m-markdown');
  await expect(reply.getByRole('link')).toHaveCount(1);
  await expect(reply.getByRole('link')).toHaveAttribute('href', 'https://example.com/');
  await expect(reply.locator('script,img,iframe')).toHaveCount(0);
  await expect(reply).toContainText('图片替代文字');
  expect(await page.evaluate(() => 'markdownExecuted' in window)).toBe(false);
  expect(mediaRequests).toEqual([]);
});

import { test, expect } from "./fixtures";
import { resolve } from "node:path";

test("visible summary precedes real replay acceptance; result, tools, repeat request and narrow layout", async ({
  page,
  server,
}) => {
  let observed = false;
  await page.route("**/summary-displayed", async (route) => {
    await expect(page.getByRole("region", { name: "操作摘要" })).toBeVisible();
    expect(server.audit()).toHaveLength(0);
    observed = true;
    await route.continue();
  });
  await page.goto(server.url);
  await expect(page.getByText("离线回放 · 不操作游戏")).toBeVisible();
  expect(page.url()).not.toContain("token");
  await page.getByLabel("完整指令").fill("帮我刷 1-7 10 次，不吃药不碎石");
  await page.getByRole("button", { name: "发送指令" }).dblclick();
  await expect(
    page.getByRole("heading", { name: "已确认完成 10/10 次" }),
  ).toBeVisible();
  expect(observed).toBe(true);
  expect(server.audit()).toHaveLength(1);
  await expect(page.getByText("目标次数已完成。")).toBeVisible();
  await page.getByText("查看 Tool Call 与请求记录").click();
  await expect(
    page.getByRole("heading", { name: "tool_call", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: resolve(import.meta.dirname, "../../.artifacts/checks/web-desktop.png"),
    fullPage: true,
  });
  await page.unroute("**/summary-displayed");
  await page.getByLabel("完整指令").fill("刷1-7一次");
  await page.getByRole("button", { name: "发送指令" }).click();
  await expect(
    page.getByRole("heading", { name: "已确认完成 1/1 次" }),
  ).toBeVisible();
  expect(server.audit()).toHaveLength(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: resolve(import.meta.dirname, "../../.artifacts/checks/web-mobile.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "已确认完成 1/1 次" }),
  ).toBeVisible();
  expect(server.audit()).toHaveLength(2);
});

test("unsupported and incomplete instructions never create executions", async ({
  page,
  server,
}) => {
  await page.goto(server.url);
  for (const original of [
    "你能做什么",
    "刷1-7",
    "刷2-1十次",
    "刷1-7十次，允许吃药",
    "刷1-7十次，五分钟内完成",
  ]) {
    await page.getByLabel("完整指令").fill(original);
    await page.getByRole("button", { name: "发送指令" }).click();
    await expect(
      page.getByText(
        "当前仅支持 1-7 明确次数、不吃药不碎石。请重新给出完整指令。",
      ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "发送指令" })).toBeEnabled();
    expect(server.audit()).toHaveLength(0);
  }
});

test("refresh before acknowledgement is read-only and cannot resume execution", async ({
  page,
  server,
}) => {
  await page.route("**/summary-displayed", (route) => route.abort());
  await page.goto(server.url);
  await page.getByLabel("完整指令").fill("刷1-7十次");
  await page.getByRole("button", { name: "发送指令" }).click();
  await expect(page.getByRole("region", { name: "操作摘要" })).toBeVisible();
  await page.reload();
  await page.unroute("**/summary-displayed");
  await expect(
    page.getByText("这是只读恢复的摘要，不会自动补发回执或执行。"),
  ).toBeVisible();
  expect(server.audit()).toHaveLength(0);
});

test("a second execution cannot replace the current task card", async ({
  page,
  server,
}) => {
  await page.goto(server.url);
  await page.getByLabel("完整指令").fill("刷1-7 100 次");
  await page.getByRole("button", { name: "发送指令" }).click();
  await expect(page.getByRole("region", { name: "当前任务" })).toBeVisible();
  const first = await page
    .getByRole("region", { name: "当前任务" })
    .locator(".identifier")
    .innerText();
  await page.getByLabel("完整指令").fill("刷1-7十次");
  await expect(page.getByRole("button", { name: "发送指令" })).toBeDisabled();
  await expect(page.getByRole("heading", { name: "设备暂不能接受新任务" })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "当前任务" }).locator(".identifier"),
  ).toHaveText(first);
  expect(server.audit()).toHaveLength(1);
  await page.getByRole("button", { name: "停止当前任务" }).click();
});

test.describe("model failure", () => {
  test.use({ modelMode: "fail-before" });
  test("failure before submission is reported without a task", async ({
    page,
    server,
  }) => {
    await page.goto(server.url);
    await page.getByLabel("完整指令").fill("刷1-7十次");
    await page.getByRole("button", { name: "发送指令" }).click();
    await expect(page.getByText(/模型或展示流程未完成/)).toBeVisible();
    expect(server.audit()).toHaveLength(0);
  });
});

test.describe("stalled model", () => {
  test.use({ modelMode: "stall-after" });
  test("task polling, new-tab control and stop are independent of the model; disconnection preserves facts", async ({
    page,
    context,
    server,
  }) => {
    await page.goto(server.url);
    await page.getByLabel("完整指令").fill("刷1-7 100 次");
    await page.getByRole("button", { name: "发送指令" }).click();
    await expect(page.getByRole("region", { name: "当前任务" })).toBeVisible();
    await expect(page.getByRole("button", { name: "发送指令" })).toBeDisabled();
    const another = await context.newPage();
    await another.goto(server.url);
    await expect(
      another.getByRole("region", { name: "当前任务" }),
    ).toBeVisible();
    await another.getByRole("button", { name: "停止当前任务" }).click();
    await expect(
      another.getByText("自动化已停止", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("自动化已停止", { exact: true })).toBeVisible();
    await page.route("**/api/**", (route) => route.abort());
    await expect(page.getByRole("alert")).toContainText(
      "页面与 Backend 连接中断",
    );
    await expect(page.getByRole("region", { name: "当前任务" })).toBeVisible();
    expect(server.audit()).toHaveLength(1);
    await page.unroute("**/api/**");
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
});

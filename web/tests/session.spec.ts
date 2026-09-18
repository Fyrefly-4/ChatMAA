import { test, expect } from "./fixtures";

test("a new startup token clears old IDs and discovers the current task in the same tab", async ({
  page,
  context,
  server,
}) => {
  await page.goto(server.address);
  await page.evaluate(() => {
    sessionStorage.setItem("chatmaa.token", "previous-instance");
    sessionStorage.setItem("chatmaa.requestId", "old-request");
    sessionStorage.setItem("chatmaa.taskId", "old-task");
  });
  await page.reload();
  const controller = await context.newPage();
  await controller.goto(server.url);
  await controller.getByLabel("完整指令").fill("刷1-7 100 次");
  await controller.getByRole("button", { name: "发送指令" }).click();
  await expect(
    controller.getByRole("region", { name: "当前任务" }),
  ).toBeVisible();
  const taskId = await controller
    .getByRole("region", { name: "当前任务" })
    .locator(".identifier")
    .innerText();
  // Same origin/path: this navigation is a fragment change, not a new document.
  await page.goto(server.url);
  await expect(
    page.getByRole("region", { name: "当前任务" }).locator(".identifier"),
  ).toHaveText(taskId);
  expect(
    await page.evaluate(() => sessionStorage.getItem("chatmaa.requestId")),
  ).toBeNull();
  await page.getByRole("button", { name: "停止当前任务" }).click();
  await expect(page.getByText("自动化已停止", { exact: true })).toBeVisible();
  expect(server.audit()).toHaveLength(1);
  const saved = await controller.evaluate(() => [
    sessionStorage.getItem("chatmaa.requestId"),
    sessionStorage.getItem("chatmaa.taskId"),
  ]);
  await controller.goto(server.url);
  await controller.reload();
  expect(
    await controller.evaluate(() => [
      sessionStorage.getItem("chatmaa.requestId"),
      sessionStorage.getItem("chatmaa.taskId"),
    ]),
  ).toEqual(saved);
});

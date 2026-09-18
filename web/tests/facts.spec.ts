import { test, expect } from "@playwright/test";
import type { TaskView } from "../src/api";
// Presentation fixtures only: these do not claim Adapter or real-game evidence.
const snapshot: TaskView = {
  id: "fixture-task",
  params: { stage: "1-7", count: 10, medicine: 0, premium: 0 },
  seq: 3,
  state: "ended",
  confirmed: 3,
  certainty: "exact",
  device: "needs_check",
  reason: "stopped",
  automation_stopped: true,
  started_cycles: 4,
  unsettled_cycles: 1,
  evidence_source: "presentation_fixture",
  cursor: 3,
  gap: false,
  sync: { available: true, last_success_at: 1, reason: null },
  updated_at: 1,
};
test("partial counts, uncertain evidence, stale terminal timestamps and stop delivery remain distinct", async ({
  page,
}) => {
  // Serve the actual built app while replacing only its API responses.
  const { readFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  let task = { ...snapshot };
  await page.route("http://chatmaa.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/status")
      return route.fulfill({
        json: {
          mode: "offline_callback_replay",
          modelAvailable: false,
          closing: false,
          busy: false,
          conflictingTaskIds: ["fixture-task"],
        },
      });
    if (path === "/api/tasks/fixture-task")
      return route.fulfill({ json: task });
    const file = resolve(
      import.meta.dirname,
      "../dist",
      path === "/" ? "index.html" : path.slice(1),
    );
    return route.fulfill({
      body: await readFile(file),
      contentType: path.endsWith(".js")
        ? "text/javascript"
        : path.endsWith(".css")
          ? "text/css"
          : "text/html",
    });
  });
  await page.goto("http://chatmaa.test/#token=fixture");
  await expect(
    page.getByRole("heading", { name: "已确认完成 3/10 次" }),
  ).toBeVisible();
  await expect(page.getByText("本轮未完成 7 次，不自动补刷。")).toBeVisible();
  await expect(page.getByText("自动化已停止", { exact: true })).toBeVisible();
  await expect(page.getByText(/Backend 暂时无法同步/)).toHaveCount(0);
  task = {
    ...snapshot,
    state: "unknown",
    certainty: "lower_bound",
    gap: true,
    automation_stopped: false,
    sync: {
      available: false,
      last_success_at: 1,
      reason: "adapter_unavailable",
    },
  };
  await expect(
    page.getByRole("heading", { name: "至少确认 3 次，其余待核对" }),
  ).toBeVisible();
  await expect(page.getByText("本轮未完成 7 次，不自动补刷。")).toHaveCount(0);
  await expect(page.getByText(/Backend 暂时无法同步/)).toBeVisible();
  await expect(
    page.getByText("尚未确认自动化停止", { exact: true }),
  ).toBeVisible();
});

for (const lateReceipt of [false, true]) {
  test(`execution evidence resolves stop feedback even with a ${lateReceipt ? "late" : "prompt"} receipt`, async ({ page }) => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    let task: TaskView = {
      ...snapshot, state: "running", certainty: "lower_bound",
      automation_stopped: false, reason: null,
    };
    let releaseReceipt!: () => void;
    const receiptReady = new Promise<void>((resolve) => { releaseReceipt = resolve; });
    await page.route("http://chatmaa.test/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/status") return route.fulfill({ json: {
        mode: "offline_callback_replay", modelAvailable: false,
        closing: false, busy: false, conflictingTaskIds: [task.id],
      } });
      if (path === `/api/tasks/${task.id}`) return route.fulfill({ json: task });
      if (path === `/api/tasks/${task.id}/stop`) {
        if (lateReceipt) await receiptReady;
        return route.fulfill({ status: 202, json: { delivered: true, confirmed: false } });
      }
      return route.fulfill({
        body: await readFile(resolve(import.meta.dirname, "../dist", path === "/" ? "index.html" : path.slice(1))),
        contentType: path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html",
      });
    });
    await page.goto("http://chatmaa.test/#token=fixture");
    await page.getByRole("button", { name: "停止当前任务" }).click();
    if (!lateReceipt) {
      await expect(page.getByText("停止请求已受理，等待执行端确认。")).toBeVisible();
      await expect(page.getByText("尚未确认自动化停止", { exact: true })).toBeVisible();
    }
    task = { ...task, state: "ended", automation_stopped: true, reason: "user_stop" };
    await expect(page.getByText("自动化已停止", { exact: true })).toBeVisible();
    releaseReceipt();
    await expect(page.getByRole("button", { name: "停止当前任务" })).toBeDisabled();
    await expect(page.getByText("执行端已确认停止自动化。")).toBeVisible();
    await expect(page.getByText("停止请求已受理，等待执行端确认。")).toHaveCount(0);
    await expect(page.getByText("用户请求停止", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "至少确认 3 次，其余待核对" })).toBeVisible();
    await expect(page.getByText(/设备占用或环境待核对/)).toBeVisible();
    task = { ...task, reason: "user_stop_before_start" };
    await expect(page.getByText("启动作战前收到停止请求", { exact: true })).toBeVisible();
    task = { ...task, reason: "unrecognized_reason" };
    await expect(page.getByText("需要核对（unrecognized_reason）")).toBeVisible();
  });
}

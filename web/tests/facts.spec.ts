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

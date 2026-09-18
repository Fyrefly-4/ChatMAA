import { test, expect } from "./fixtures";

for (const failure of ["before-delivery", "lost-response"] as const) {
  test(`summary receipt reconciles ${failure} without repeating execution`, async ({
    page,
    server,
  }) => {
    const receipts: unknown[] = [];
    await page.route("**/summary-displayed", async (route) => {
      receipts.push(route.request().postDataJSON());
      if (receipts.length === 1) {
        if (failure === "lost-response") await route.fetch();
        await route.abort();
      } else await route.continue();
    });
    await page.goto(server.url);
    await page.getByLabel("完整指令").fill("刷1-7十次");
    await page.getByRole("button", { name: "发送指令" }).click();
    await expect(
      page.getByRole("heading", { name: "已确认完成 10/10 次" }),
    ).toBeVisible({ timeout: 10000 });
    expect(server.audit()).toHaveLength(1);
    if (failure === "before-delivery") {
      expect(receipts).toHaveLength(2);
      expect(receipts[1]).toEqual(receipts[0]);
    } else expect(receipts).toHaveLength(1);
  });
}

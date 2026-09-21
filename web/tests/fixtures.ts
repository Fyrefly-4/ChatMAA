import { test as base, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
type Server = {
  address: string;
  token: string;
  dataDir: string;
  childPid: number;
  url: string;
  audit: () => string[];
};
export const test = base.extend<{ server: Server; modelMode: string; mvp: boolean }>({
  mvp: [false, { option: true }],
  modelMode: ["normal", { option: true }],
  server: async ({ modelMode, mvp }, use) => {
    const child = spawn(
      process.execPath,
      [resolve(import.meta.dirname, mvp ? "../../backend/tests/mvp-browser-server.ts" : "../../backend/tests/browser-server.ts")],
      {
        cwd: resolve(import.meta.dirname, "../.."),
        windowsHide: true,
        env: {
          ...process.env,
          DEEPSEEK_API_KEY: "",
          TEST_MODEL_MODE: modelMode,
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    let logs = "";
    child.stdout?.on("data", (b) => {
      logs += b;
    });
    child.stderr?.on("data", (b) => {
      logs += b;
    });
    let closed: { childExited: boolean; handoffComplete: boolean } | undefined;
    child.on("message", (message) => {
      if ((message as { kind: string }).kind === "closed")
        closed = message as typeof closed;
    });
    const exit = new Promise<number | null>((resolve) =>
      child.once("exit", resolve),
    );
    const info = await new Promise<Omit<Server, "url" | "audit">>(
      (ok, fail) => {
        const timer = setTimeout(
          () => fail(new Error(`fixture startup timeout: ${logs}`)),
          12000,
        );
        child.once("error", fail);
        child.once("exit", () => fail(new Error(`fixture exited: ${logs}`)));
        child.on("message", (message) => {
          const value = message as Omit<Server, "url" | "audit"> & {
            kind: string;
          };
          if (value.kind === "ready") {
            clearTimeout(timer);
            ok(value);
          }
        });
      },
    );
    try {
      await use({
        ...info,
        url: `${info.address}/#token=${info.token}`,
        audit: () => {
          try {
            return readFileSync(
              resolve(info.dataDir, "worker-audit.jsonl"),
              "utf8",
            )
              .trim()
              .split("\n")
              .filter(Boolean);
          } catch {
            return [];
          }
        },
      });
    } finally {
      child.send("close");
      const timer = setTimeout(() => child.kill(), 10000);
      const code = await exit;
      clearTimeout(timer);
      expect(code, logs).toBe(0);
      expect(closed).toMatchObject({
        childExited: true,
        handoffComplete: true,
      });
      expect(() => process.kill(info.childPid, 0)).toThrow();
    }
  },
});
export { expect };

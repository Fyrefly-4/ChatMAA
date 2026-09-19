// Offline browser fixture: formal host/storage/replay; only the language model is replaced.
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { repository } from "../src/config.ts";
import { startHost } from "../src/host.ts";
import { createApp } from "../src/app.ts";
import { BrowserRequests } from "../src/browser/requests.ts";
import { authorize } from "../src/agent/policy.ts";
import { randomUUID } from "node:crypto";
import { seedUncertain } from './takeover-fixture.ts';

const dataDir = resolve(repository, ".artifacts/checks", `web-${randomUUID()}`);
mkdirSync(dataDir, { recursive: true });
if (process.env.TEST_MODEL_MODE === 'history') seedUncertain(dataDir);
const host = await startHost({
  mode: "maa-replay",
  dataDir,
  port: 0,
  pollMs: 40,
  httpTimeoutMs: 500,
  leaseMs: 5000,
  stopDeadlineMs: 2000,
  python: resolve(repository, "adapter/maa/.venv/Scripts/python.exe"),
});
const output = (
  content: LanguageModelV4GenerateResult["content"],
): LanguageModelV4GenerateResult => ({
  content,
  finishReason: {
    unified: content.some((c) => c.type === "tool-call")
      ? "tool-calls"
      : "stop",
    raw: undefined,
  },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
  warnings: [],
});
const model = new MockLanguageModelV4({
  doGenerate: async (options) => {
    if (process.env.TEST_MODEL_MODE === "fail-before")
      throw new Error("offline model failure");
    const original = options.prompt
      .filter((m) => m.role === "user")
      .flatMap((m) => m.content)
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");
    const permission = authorize(original);
    if (
      !options.prompt.some((m) => m.role === "tool") &&
      permission.action === "submit"
    ) {
      return output([
        {
          type: "tool-call",
          toolCallId: randomUUID(),
          toolName: "submit_task",
          input: JSON.stringify(permission.params),
        },
      ]);
    }
    if (
      permission.action === "submit" &&
      process.env.TEST_MODEL_MODE === "stall-after"
    )
      return new Promise(() => {});
    return output([
      {
        type: "text",
        text:
          permission.action === "submit"
            ? "请求已交给任务服务，请查看执行事实。"
            : "当前仅支持 1-7 明确次数、不吃药不碎石。请重新给出完整指令。",
      },
    ]);
  },
});
const requests = new BrowserRequests(host.tasks, model, { timeoutMs: 15000 });
const token = randomUUID();
let address = "";
const app = createApp(host.tasks, randomUUID(), () => {}, {
  requests,
  token,
  origin: () => address,
  staticRoot: resolve(repository, "web/dist"),
});
address = await app.listen({ host: "127.0.0.1", port: 0 });
process.send?.({ kind: "ready", address, token, dataDir, childPid: host.pid });
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await requests.close();
  await app.close();
  const result = await host.close();
  process.send?.({ kind: "closed", ...result });
  process.disconnect();
  process.exitCode = result.childExited && result.handoffComplete ? 0 : 1;
}
process.on("message", (message) => {
  if (message === "close") void close();
});
process.on("disconnect", () => {
  void close();
});

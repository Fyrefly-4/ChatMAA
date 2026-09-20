import type {
  BrowserRequests,
  Receipt,
} from "../../backend/src/browser/requests.ts";
import type { TaskView } from "../../backend/src/task-contract.ts";
export type { TaskView, Receipt };
export type RequestView = ReturnType<BrowserRequests["read"]>;
export type Status = {
  mode: string;
  modelAvailable: boolean;
  closing: boolean;
  busy: boolean;
  adapterAvailable: boolean;
  storageFailed: boolean;
  conflictingTaskIds: string[];
  device: import("../../backend/src/task-contract.ts").BackendDeviceStatus | null;
};

function acceptStartupToken() {
  const received = new URLSearchParams(location.hash.slice(1)).get("token");
  if (!received) return false;
  const changed = received !== sessionStorage.getItem("chatmaa.token");
  if (changed) {
    sessionStorage.removeItem("chatmaa.requestId");
    sessionStorage.removeItem("chatmaa.taskId");
  }
  sessionStorage.setItem("chatmaa.token", received);
  history.replaceState(null, "", location.pathname + location.search);
  return changed;
}
acceptStartupToken();
// Opening a new startup URL in this tab may only change the fragment.
// Reload after a token change to also discard the mounted hook's old IDs/eligibility.
window.addEventListener("hashchange", () => {
  if (acceptStartupToken()) location.reload();
});
export const hasToken = !!sessionStorage.getItem("chatmaa.token");
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "x-web-token": sessionStorage.getItem("chatmaa.token") ?? "",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const value = await response.json();
  if (!response.ok)
    throw new ApiError(response.status, value.error ?? "request_failed");
  return value as T;
}
export function errorText(error: unknown) {
  if (!(error instanceof ApiError))
    return "页面与 Backend 连接中断，保留最后已知结果。";
  const messages: Record<string, string> = {
    recovery_preconditions_changed: "设备状态或阻塞记录已变化，请重新读取并确认。",
    recovery_evidence_unavailable: "历史证据尚未完整同步，暂不能放行。请保留记录并检查执行端连接。",
    recovery_id_conflict: "核对标识与原内容冲突，本次未执行核对。",
    device_busy_or_uncertain: "设备仍被占用或待核对，请处理页面中的阻塞；重复发送不能解除阻塞。",
    unauthorized: "访问凭据或来源无效，请从 Backend 本次启动地址重新打开。",
    model_unavailable: "模型尚未配置；已有任务仍可查询和停止。",
    request_busy: "另一条模型请求正在处理，本条未排队。",
    request_id_conflict: "请求标识与原内容冲突，本条未重新执行。",
    unknown_request: "尚未查到该请求；不会自动重发，请核对 Backend 记录。",
    unknown_task: "未找到该任务，请核对当前 Backend 和数据目录。",
    service_closing: "Backend 正在退出。",
    service_unavailable: "服务暂不可用，已有结果继续保留。",
    invalid_request: "请输入完整指令（不超过 8000 字）。",
    summary_not_pending: "摘要回执已过期或请求已结束，不会恢复执行。",
  };
  return messages[error.message] ?? `操作未完成：${error.message}`;
}

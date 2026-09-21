import { api, ApiError } from '../api';
export { api, ApiError };
export type { MvpStatus } from '../../../backend/src/browser/mvp-routes';
export type { MvpConversation, PlanView, MessagePage, TurnPage, EvidencePage, BusinessTask } from '../../../backend/src/browser/mvp-queries';
export type { Message, Presentation } from '../../../backend/src/business/records';
export type { Turn, Activity } from '../../../backend/src/runtime/records';
export const id = () => crypto.randomUUID();
export const pathId = (value: string) => encodeURIComponent(value);
export function failure(error: unknown) {
  if (!(error instanceof ApiError)) return '页面与后台连接中断，保留最后已知状态。操作是否受理仍需核对。';
  const messages: Record<string, string> = {
    unauthorized: '访问凭据已失效，请从后台本次启动地址重新打开。',
    plan_not_current: '方案已更新或依据已失效，请查看当前方案并重新确认。',
    presentation_required: '方案展示尚未登记，请等待页面完成展示。',
    business_unavailable: '业务处理暂不可用，已有事实仍保留；请查看连接与环境详情。',
    device_busy_or_uncertain: '游戏环境被占用或尚待核对；本次没有排队。',
    service_unavailable: '服务暂不可用，请查看连接和环境状态。',
    service_closing: '后台正在退出，保留已有记录。',
    request_not_current: '需求已变化，请查看最新方案或任务。',
    recovery_preconditions_changed: '核对范围已变化，请重新读取环境状态后确认。',
    recovery_evidence_unavailable: '历史证据尚不完整，暂时不能放行。',
  };
  return messages[error.message] ?? `操作未完成：${error.message}`;
}

export function saved<T>(key: string, fallback: T): T {
  try { return JSON.parse(sessionStorage.getItem(`chatmaa.mvp.${key}`) ?? 'null') ?? fallback; } catch { return fallback; }
}
export function save(key: string, value: unknown) { sessionStorage.setItem(`chatmaa.mvp.${key}`, JSON.stringify(value)); }

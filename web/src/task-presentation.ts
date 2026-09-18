import type { TaskView } from "./api";
const states: Record<string, string> = {
  accepted: "任务已受理",
  running: "执行中",
  stopping: "停止中",
  ended: "本轮已结束",
  rejected: "未受理",
  unknown: "执行状态待核对",
};
const reasons: Record<string, string> = {
  target_reached: "已达到目标次数",
  stopped: "已停止",
  stop_requested: "已请求停止",
  user_stop: "用户请求停止",
  user_stop_before_start: "启动作战前收到停止请求",
  environment_unconfirmed: "环境尚未确认（environment_unconfirmed）",
  resource_load_failed: "资源加载失败（resource_load_failed）",
  execution_or_evidence_error: "执行或证据异常（execution_or_evidence_error）",
  runtime_error: "执行期间发生异常（runtime_error）",
  executor_exited: "执行端已退出",
  submission_not_confirmed: "受理结果尚未确认",
  insufficient_sanity: "理智不足",
  readiness_failed: "环境识别未通过",
};
export function taskPresentation(task: TaskView) {
  const exact =
    task.certainty === "exact" && !task.gap && !task.evidence_conflict;
  return {
    state: states[task.state] ?? `状态待核对（${task.state}）`,
    reason: task.reason
      ? (reasons[task.reason] ?? `需要核对（${task.reason}）`)
      : "暂无",
    count: exact
      ? `已确认完成 ${task.confirmed}/${task.params.count} 次`
      : `至少确认 ${task.confirmed} 次，其余待核对`,
    remaining:
      task.state === "ended" && exact
        ? task.confirmed === task.params.count
          ? "目标次数已完成。"
          : `本轮未完成 ${Math.max(0, task.params.count - task.confirmed)} 次，不自动补刷。`
        : "",
    stopped: task.automation_stopped ? "自动化已停止" : "尚未确认自动化停止",
    environment:
      task.device === "ready"
        ? "上次证据显示设备就绪，不代表实时环境许可。"
        : "设备占用或环境待核对；不自动解锁，请人工检查。",
  };
}

import type { BusinessTask, PlanView } from './api';
import type { Amount } from '../../../backend/src/business/goals';
export function amount(value: Amount | undefined | null) {
  if (!value || value.value === null || value.certainty === 'unknown') return '未知';
  return `${value.certainty === 'lower_bound' ? '至少 ' : ''}${value.value}`;
}
export function planTitle(p: PlanView) {
  if (p.goal.kind === 'count') return `${p.stage} · 成功完成 ${p.quantity} 次`;
  return `${p.itemName} · ${p.goal.kind === 'inventory' ? '补到' : '再获得'} ${p.goal.quantity} 个`;
}
export const planStates: Record<string, string> = { unpresented: '正在展示', presented: '待确认', stale: '依据待更新',
  superseded: '历史方案', cancelled: '已取消', started: '已关联任务' };
export function execution(t: BusinessTask) {
  const v = t.task;
  if (v.automation_stopped && v.state === 'ended') return '自动化已停止';
  return ({ submitting: '提交中', accepted: '执行端已受理', running: '执行中', stopping: '停止中', unknown: '状态待核对', rejected: '未受理' } as Record<string, string>)[v.state] ?? '状态待核对';
}
export const processText: Record<string, string> = { succeeded: '过程成功', stopped: '用户停止', partial: '部分完成', failed: '执行失败', unknown: '过程结果待核实', running: '执行过程尚未结束' };
export const targetText: Record<string, string> = { achieved: '目标已达成', not_achieved: '目标未达成', uncertain: '目标结果待核实' };
export const reasonText: Record<string, string> = { normal: '执行端正常结束回调；不足以单独判断过程成功',
  target_reached: '已达到执行目标', sanity_insufficient: '理智不足', user_stop: '用户请求停止', user_stop_before_start: '开始前请求停止',
  stop_requested: '已请求停止', evidence_gap: '执行证据存在缺口', submission_not_confirmed: '提交结果尚未确认',
  environment_unconfirmed: '游戏环境未确认', runtime_error: '执行端异常' };
export const waitingText: Record<string, string> = { kind: '目标类型', quantity: '目标数量', itemId: '材料名称', stage: '关卡',
  inventory_required: '需要可靠库存依据', scan_pending: '等待库存扫描', stop_or_environment_unconfirmed: '等待停止与环境核对',
  previous_result_uncertain: '旧成果尚不能精确核算', stage_required: '需要选定关卡' };
export function time(value: string | number | null | undefined) {
  if (value === null || value === undefined) return '暂无更新时间';
  return new Date(typeof value === 'number' ? value * 1000 : value).toLocaleString('zh-CN', { hour12: false });
}

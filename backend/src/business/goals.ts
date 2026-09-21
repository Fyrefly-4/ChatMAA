import { MAX_COUNT, TaskError } from '../task-contract.ts';
import type { TaskView } from '../task-contract.ts';
import type { ExecutionParams } from '../execution-contract.ts';

export type GoalDraft = { kind?: 'count' | 'material' | 'inventory'; quantity?: number; itemId?: string; stage?: string };
export type Goal = GoalDraft & { kind: 'count' | 'material' | 'inventory'; quantity: number };
export type Amount = { value: number | null; certainty: 'exact' | 'lower_bound' | 'unknown' };
export function goalDraft(value: unknown): GoalDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TaskError(422, 'invalid_goal');
  const v = value as GoalDraft;
  if (Object.keys(v).some(k => !['kind', 'quantity', 'itemId', 'stage'].includes(k)) ||
      (v.kind !== undefined && !['count', 'material', 'inventory'].includes(v.kind)) ||
      (v.quantity !== undefined && (!Number.isSafeInteger(v.quantity) || v.quantity < 1 || v.quantity > MAX_COUNT)) ||
      (v.itemId !== undefined && (typeof v.itemId !== 'string' || !/^[A-Za-z0-9_]{1,80}$/.test(v.itemId))) ||
      (v.stage !== undefined && (typeof v.stage !== 'string' || !/^[A-Z0-9][A-Z0-9-]{0,39}$/.test(v.stage))) ||
      (v.kind === 'count' && v.itemId !== undefined)) throw new TaskError(422, 'unsupported_goal');
  return { ...v };
}
export function missingGoal(draft: GoalDraft): string[] {
  return [...(!draft.kind ? ['kind'] : []), ...(draft.quantity === undefined ? ['quantity'] : []),
    ...(draft.kind && draft.kind !== 'count' && !draft.itemId ? ['itemId'] : []),
    ...(draft.kind === 'count' && !draft.stage ? ['stage'] : [])];
}
export function executionParams(goal: Goal, stage: string, quantity: number): ExecutionParams {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_COUNT) throw new TaskError(422, 'invalid_execution_quantity');
  const common = { version: 2 as const, stage, series: 1, medicine: 0 as const, premium: 0 as const };
  if (goal.kind === 'count') return { ...common, kind: 'fight_count', count: quantity };
  if (!goal.itemId) throw new TaskError(422, 'material_required');
  return { ...common, kind: 'fight_material', item_id: goal.itemId, quantity };
}
export function amount(task: TaskView, goal: Goal): Amount {
  const result = goal.kind === 'count' ? task.count_result : task.material_result;
  const value = goal.kind === 'count' ? task.count_result?.value : task.material_result?.items[goal.itemId!];
  // Missing material entries are unknown, never implicitly zero.
  if (task.evidence_conflict || !result || value === undefined || !Number.isSafeInteger(value) || value < 0 ||
      !['exact', 'lower_bound'].includes(result.certainty)) return { value: null, certainty: 'unknown' };
  return { value, certainty: task.gap || !task.sync.available ? 'lower_bound' : result.certainty as 'exact' | 'lower_bound' };
}
export function sumAmounts(values: Amount[]): Amount {
  if (values.some(a => a.value === null || a.certainty === 'unknown')) return { value: null, certainty: 'unknown' };
  const value = values.reduce((sum, a) => sum + a.value!, 0);
  if (!Number.isSafeInteger(value)) return { value: null, certainty: 'unknown' };
  return { value, certainty: values.every(a => a.certainty === 'exact') ? 'exact' : 'lower_bound' };
}
export type GoalResult = {
  execution: { state: string; automationStopped: boolean; reason: string | null };
  process: 'succeeded' | 'stopped' | 'partial' | 'failed' | 'unknown' | 'running';
  target: 'achieved' | 'not_achieved' | 'uncertain';
  amount: Amount; cumulative: Amount; initialInventory: number | null; estimatedInventory: Amount | null;
  remaining: number | null; differenceFromConfirmed: number | null; rescanned: false;
};
export function goalResult(task: TaskView, goal: Goal, prior: Amount = { value: 0, certainty: 'exact' }, initialInventory: number | null = null): GoalResult {
  const current = amount(task, goal);
  const cumulative = sumAmounts([prior, current]);
  const available = goal.kind === 'inventory' ? (initialInventory === null ? null : cumulative.value === null ? null : initialInventory + cumulative.value) : cumulative.value;
  const target = available === null ? 'uncertain' : available >= goal.quantity ? 'achieved' : cumulative.certainty === 'exact' ? 'not_achieved' : 'uncertain';
  const reason = task.reason;
  const terminal = task.state === 'ended' && task.automation_stopped;
  const process = task.state === 'rejected' ? 'failed' : !terminal ? (task.state === 'unknown' ? 'unknown' : 'running') :
    reason === 'user_stop' || reason === 'user_stop_before_start' || reason === 'stop_requested' ? 'stopped' :
    ['resource_load_failed', 'resource_validation_failed', 'runtime_error', 'execution_or_evidence_error', 'environment_unconfirmed'].includes(reason ?? '') ? 'failed' :
    reason === 'target_reached' ? 'succeeded' : reason === 'sanity_insufficient' ? 'partial' : 'unknown';
  return { execution: { state: task.state, automationStopped: task.automation_stopped, reason }, process, target,
    amount: current, cumulative, initialInventory, estimatedInventory: goal.kind === 'inventory' ? { value: available, certainty: available === null ? 'unknown' : cumulative.certainty } : null,
    remaining: available !== null && cumulative.certainty === 'exact' ? Math.max(goal.quantity - available, 0) : null,
    differenceFromConfirmed: available !== null ? Math.max(goal.quantity - available, 0) : null, rescanned: false };
}
export function resultText(goal: Goal, result: GoalResult): string {
  const execution = result.execution.automationStopped ? '自动化已停止' : '自动化停止尚未确认';
  const unit = goal.kind === 'count' ? '次' : '个目标材料';
  const count = result.amount.value === null ? '本次成果未知' : `本次已确认${result.amount.certainty === 'lower_bound' ? '至少' : ''}${result.amount.value}${unit}`;
  const target = { achieved: '目标已达成', not_achieved: '目标尚未达成', uncertain: '目标是否达成待核实' }[result.target];
  const inventory = result.estimatedInventory ? (result.estimatedInventory.value === null ? '；库存依据待核实' :
    `；推算库存${result.estimatedInventory.certainty === 'lower_bound' ? '至少' : ''}${result.estimatedInventory.value}，未重新扫描`) : '';
  const remainder = result.remaining === null ? '；不能给出精确剩余量' : `；剩余${result.remaining}`;
  return `${execution}；${count}；${target}${inventory}${remainder}。停止不撤销消耗，也不表示游戏内战斗立即结束。`;
}

import { MAX_COUNT, TaskError, taskId, submission } from './task-contract.ts';
import type { Params } from './task-contract.ts';

type Fight = { version: 2; stage: string; series: number; medicine: 0; premium: 0 };
export type ExecutionParams =
  | { version: 2; kind: 'scan_inventory' }
  | (Fight & { kind: 'fight_count'; count: number })
  | (Fight & { kind: 'fight_material'; item_id: string; quantity: number; max_count?: number });
export type AnyParams = Params | ExecutionParams;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function positive(value: unknown, max = MAX_COUNT): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max;
}
export function executionSubmission(value: unknown): { id: string; params: AnyParams } {
  if (!object(value) || Object.keys(value).sort().join() !== 'id,params' || !object(value.params)) {
    throw new TaskError(422, 'invalid_submission');
  }
  const p = value.params;
  if (!('version' in p) && !('kind' in p)) return submission(value);
  const id = taskId(value.id);
  if (p.version !== 2) throw new TaskError(422, 'unsupported_contract_version');
  if (p.kind === 'scan_inventory' && Object.keys(p).sort().join() === 'kind,version') {
    return { id, params: { version: 2, kind: p.kind } };
  }
  if (typeof p.stage !== 'string' || !/^[A-Z0-9][A-Z0-9-]{0,39}$/.test(p.stage) ||
      !positive(p.series, 10) || p.medicine !== 0 || p.premium !== 0) throw new TaskError(422, 'unsupported_parameters');
  const common: Fight = { version: 2, stage: p.stage, series: p.series, medicine: 0, premium: 0 };
  if (p.kind === 'fight_count' && positive(p.count) &&
      Object.keys(p).sort().join() === 'count,kind,medicine,premium,series,stage,version') {
    return { id, params: { ...common, kind: p.kind, count: p.count } };
  }
  if (p.kind === 'fight_material' && positive(p.quantity) && typeof p.item_id === 'string' &&
      /^[A-Za-z0-9_]{1,80}$/.test(p.item_id) &&
      ((!('max_count' in p) && Object.keys(p).sort().join() === 'item_id,kind,medicine,premium,quantity,series,stage,version') ||
       (positive(p.max_count) && Object.keys(p).sort().join() === 'item_id,kind,max_count,medicine,premium,quantity,series,stage,version'))) {
    return { id, params: { ...common, kind: p.kind, item_id: p.item_id, quantity: p.quantity,
      ...('max_count' in p ? { max_count: p.max_count as number } : {}) } };
  }
  throw new TaskError(422, 'unsupported_parameters');
}

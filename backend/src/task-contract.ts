// MaaCore v6.17.5 FightTask::set_params reads times as a signed int.
export const MAX_COUNT = 2_147_483_647;
import type { AnyParams } from './execution-contract.ts';
export type Params = { stage: '1-7'; count: number; medicine: 0; premium: 0 };
export type Submission = { id: string; params: Params };
export type EnvironmentEvidence = { ready: boolean; observed_at: number; basis: string; error?: string | null; automation_stopped?: boolean };
export type Snapshot = {
  id: string; seq: number; state: string; confirmed: number; certainty: string;
  device: string; reason: string | null; updated_at?: number; stop_requested?: boolean;
  automation_stopped: boolean; started_cycles: number; unsettled_cycles: number;
  evidence_source: string; environment?: EnvironmentEvidence; evidence_conflict?: boolean;
  operation?: 'scan_inventory' | 'fight_count' | 'fight_material'; contract_version?: number; interpretation_version?: number;
  count_result?: { value: number; certainty: string; issues: string[] };
  material_result?: { items: Record<string, number>; certainty: string; issues: string[] };
  inventory_result?: { items: Record<string, number>; complete: boolean; certainty: string; missing_items: 'unknown'; observed_at: number | null; issues: string[] };
  threshold_reached?: boolean;
  resource_digest?: string;
  takeover?: { id: string; released: boolean; environment: EnvironmentEvidence };
  recheck?: { id: string; state: string; automation_stopped: boolean; ready: boolean; environment?: EnvironmentEvidence };
};
export type Evidence = { id: string; seq: number; kind: string; source_instance: string; snapshot: Snapshot };
export type Update = { snapshot: Snapshot; events: Evidence[]; instance: string };
export type SyncStatus = { available: boolean; last_success_at: number | null; reason: string | null };
export type TaskView = Snapshot & { params: AnyParams; cursor: number; gap: boolean; sync: SyncStatus };
export function uncertainEvidence(snapshot: Snapshot, issue: string, conflict = false): Snapshot {
  const result = { ...snapshot, certainty: 'lower_bound' };
  if (snapshot.count_result) result.count_result = { ...snapshot.count_result,
    certainty: conflict || snapshot.count_result.certainty === 'unknown' ? 'unknown' : 'lower_bound', issues: [...new Set([...snapshot.count_result.issues, issue])] };
  if (snapshot.material_result) result.material_result = { ...snapshot.material_result,
    certainty: conflict || snapshot.material_result.certainty === 'unknown' ? 'unknown' : 'lower_bound', issues: [...new Set([...snapshot.material_result.issues, issue])] };
  if (snapshot.inventory_result) result.inventory_result = { ...snapshot.inventory_result,
    complete: false, certainty: 'unknown', issues: [...new Set([...snapshot.inventory_result.issues, issue])] };
  if (conflict) result.threshold_reached = false;
  return result;
}
export function blocksExecution(t: Snapshot & { gap?: boolean; sync?: SyncStatus }) {
  if (t.takeover?.released && (t.gap || t.evidence_conflict || t.sync?.available === false)) return true;
  return t.state !== 'rejected' && (!t.takeover?.released || t.evidence_conflict) &&
    (t.state !== 'ended' || !t.automation_stopped || t.device !== 'ready');
}
export type DeviceStatus = {
  blockers: { id: string; seq: number; confirmed: number; certainty: string; reason: string | null; kind: 'current' | 'historical' }[];
  recoverable: boolean;
  recovery: null | { id: string; state: string; reason: string | null; automation_stopped: boolean };
};

export class TaskError extends Error {
  status: number;
  constructor(status: number, code: string) { super(code); this.status = status; }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function taskId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw new TaskError(422, 'invalid_id');
  return value;
}
export function submission(value: unknown): Submission {
  if (!object(value) || Object.keys(value).sort().join() !== 'id,params' || !object(value.params)) {
    throw new TaskError(422, 'invalid_submission');
  }
  const p = value.params;
  if (Object.keys(p).sort().join() !== 'count,medicine,premium,stage' || p.stage !== '1-7' ||
      typeof p.count !== 'number' || !Number.isInteger(p.count) || p.count < 1 || p.count > MAX_COUNT ||
      p.medicine !== 0 || p.premium !== 0) throw new TaskError(422, 'unsupported_parameters');
  return { id: taskId(value.id), params: { stage: '1-7', count: p.count, medicine: 0, premium: 0 } };
}

// MaaCore v6.17.5 FightTask::set_params reads times as a signed int.
export const MAX_COUNT = 2_147_483_647;
export type Params = { stage: '1-7'; count: number; medicine: 0; premium: 0 };
export type Submission = { id: string; params: Params };
export type EnvironmentEvidence = { ready: boolean; observed_at: number; basis: string; error?: string | null; automation_stopped?: boolean };
export type Snapshot = {
  id: string; seq: number; state: string; confirmed: number; certainty: string;
  device: string; reason: string | null; updated_at?: number; stop_requested?: boolean;
  automation_stopped: boolean; started_cycles: number; unsettled_cycles: number;
  evidence_source: string; environment?: EnvironmentEvidence; evidence_conflict?: boolean;
  recheck?: { id: string; state: string; automation_stopped: boolean; ready: boolean; environment?: EnvironmentEvidence };
};
export type Evidence = { id: string; seq: number; kind: string; source_instance: string; snapshot: Snapshot };
export type Update = { snapshot: Snapshot; events: Evidence[]; instance: string };
export type SyncStatus = { available: boolean; last_success_at: number | null; reason: string | null };
export type TaskView = Snapshot & { params: Params; cursor: number; gap: boolean; sync: SyncStatus };

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

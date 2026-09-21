import type { TaskService } from '../task-service.ts';
import type { TaskView } from '../task-contract.ts';
import { digest } from './catalog.ts';
import type { BusinessRecords, TaskLink, Observation, Plan } from './records.ts';
import type { GoalResult } from './goals.ts';
import type { BusinessBasis } from './basis.ts';

export type ProjectionEffect =
  | { type: 'scan'; link: TaskLink; observation: Observation }
  | { type: 'result'; link: TaskLink; plan: Plan; result: GoalResult; resultDigest: string; terminal: boolean };

// Apply execution facts only. This module does not prepare plans, transition
// requests, append conversational messages, dispatch consumers or send operations.
export class FactProjection {
  readonly records: BusinessRecords;
  readonly tasks: TaskService;
  readonly basis: BusinessBasis;
  constructor(records: BusinessRecords, tasks: TaskService, basis: BusinessBasis) {
    this.records = records; this.tasks = tasks; this.basis = basis;
  }
  capture(task: TaskView): boolean {
    let changed = false;
    const record = (id: string, items: string[] | null, reason: string, taskId: string | null = null) => {
      if (!this.records.read('inventory_changes', id)) changed = true;
      this.basis.recordChange(id, items, reason, '', taskId);
    };
    const scan = 'kind' in task.params && task.params.kind === 'scan_inventory';
    if (!scan && task.state !== 'rejected') {
      const drops = task.material_result;
      const itemIds = !drops || drops.certainty !== 'exact' || task.gap || task.evidence_conflict || task.unsettled_cycles > 0
        ? null : Object.entries(drops.items).filter(([, value]) => value > 0).map(([id]) => id);
      if (task.started_cycles > 0 || Object.values(drops?.items ?? {}).some(v => v > 0)) {
        record(`task-${task.id}-${task.seq}`, itemIds, 'execution_inventory_change', task.id);
      }
    }
    if (task.takeover?.released) record(`takeover-${task.takeover.id}`, null, 'manual_takeover_inventory_unverified');
    return changed;
  }
  apply(link: TaskLink): ProjectionEffect | null {
    const task = this.tasks.get(link.id);
    if (link.purpose === 'inventory') {
      if (task.state !== 'ended' || !task.automation_stopped) return null;
      const inventory = task.inventory_result;
      const reliable = !!inventory?.complete && inventory.certainty === 'recognized' && !task.gap && !task.evidence_conflict && task.sync.available && inventory.observed_at !== null;
      const old = this.records.read('observations', task.id);
      const observedAt = inventory?.observed_at ?? 0;
      const changes = this.basis.changes(); const afterScan = changes.filter(c => c.observedAt > observedAt);
      const observation: Observation = { id: task.id, conversationId: link.conversationId, taskId: task.id,
        items: inventory?.items ?? {}, observedAt, reliable,
        changeSequence: old?.changeSequence ?? (afterScan.length ? Math.min(...afterScan.map(c => c.sequence)) - 1 : changes.length), evidenceSequence: task.seq };
      if (!old) this.records.insert('observations', observation); else this.records.save('observations', observation);
      return { type: 'scan', link, observation };
    }
    const plan = this.records.read('plan_versions', link.planId!)!;
    const terminal = task.state === 'ended' && task.automation_stopped || task.state === 'rejected';
    const completedChangeSequence = link.completedChangeSequence ?? (terminal ? this.basis.changes().length : undefined);
    const result = this.basis.calculate({ ...link, completedChangeSequence }, task); const resultDigest = digest(result);
    if (resultDigest === link.resultDigest) return null;
    this.records.save('task_links', { ...link, completedChangeSequence, result, resultDigest });
    return { type: 'result', link, plan, result, resultDigest, terminal };
  }
}

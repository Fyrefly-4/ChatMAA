import { isDeepStrictEqual } from 'node:util';
import { TaskError, taskId, blocksExecution } from '../task-contract.ts';
import type { TaskView } from '../task-contract.ts';
import type { TaskService } from '../task-service.ts';
import type { BusinessRecords, Plan, TaskLink } from './records.ts';
import type { Catalog } from './catalog.ts';
import { amount, sumAmounts, goalResult } from './goals.ts';
const fail = (code: string, status = 409): never => { throw new TaskError(status, code); };

// Inventory validity and goal results share the same evidence rules.
export class BusinessBasis {
  readonly records: BusinessRecords;
  readonly tasks: TaskService;
  readonly catalog: () => Catalog;
  constructor(records: BusinessRecords, tasks: TaskService, catalog: () => Catalog) {
    this.records = records; this.tasks = tasks; this.catalog = catalog;
  }
  changes() { return this.records.list('inventory_changes'); }
  observationValid(id: string, itemId: string, ignoreTasks: string[] = [], through = Infinity) {
    const observation = this.records.read('observations', id);
    const changes = this.changes().filter(c => c.sequence <= through);
    // Execution snapshots are cumulative. A later exact final snapshot can resolve
    // a temporary unknown drop set; manual changes remain independent evidence.
    const effective = changes.filter(c => !c.taskId || !changes.some(later => later.taskId === c.taskId && later.sequence > c.sequence));
    return !!observation?.reliable && Object.hasOwn(observation.items, itemId) &&
      !effective.some(c => c.sequence > observation.changeSequence && (!c.taskId || !ignoreTasks.includes(c.taskId)) &&
        (c.itemIds === null || c.itemIds.includes(itemId)));
  }
  planValid(plan: Plan) {
    return plan.catalogBasis === this.catalog().basis(plan.stage, plan.goal.itemId) &&
      (!plan.previousTasks.length || (plan.previousTasks.every(id => !blocksExecution(this.tasks.get(id))) &&
        isDeepStrictEqual(sumAmounts(plan.previousTasks.map(id => amount(this.tasks.get(id), plan.goal))), plan.prior))) &&
      (!plan.observationId || this.observationValid(plan.observationId, plan.goal.itemId!, plan.previousTasks));
  }
  calculate(link: TaskLink, task: TaskView) {
    const plan = this.records.read('plan_versions', link.planId!)!;
    const prior = plan.previousTasks.length ? sumAmounts(plan.previousTasks.map(id => amount(this.tasks.get(id), plan.goal))) : plan.prior;
    const result = goalResult(task, plan.goal, prior, plan.initialInventory);
    if (plan.observationId && !this.observationValid(plan.observationId, plan.goal.itemId!, [...plan.previousTasks, task.id], link.completedChangeSequence)) {
      result.estimatedInventory = { value: null, certainty: 'unknown' }; result.target = 'uncertain';
      result.remaining = null; result.differenceFromConfirmed = null;
    }
    return result;
  }
  recordChange(id: string, itemIds: string[] | null, reason: string, conversationId = '', task: string | null = null) {
    taskId(id); if (!reason || (itemIds !== null && (!Array.isArray(itemIds) || itemIds.some(i => typeof i !== 'string' || !i)))) return fail('invalid_inventory_change', 422);
    const old = this.records.read('inventory_changes', id);
    if (old) {
      if (!isDeepStrictEqual(old.itemIds, itemIds) || old.reason !== reason || old.taskId !== task || old.conversationId !== conversationId) return fail('id_parameter_conflict');
      return old;
    }
    const entry = { id, conversationId, sequence: this.changes().length + 1, taskId: task, itemIds,
      reason, observedAt: Date.now() / 1000 };
    this.records.insert('inventory_changes', entry); return entry;
  }
}

import { blocksExecution, blocksProbe, TaskError, taskId } from './task-contract.ts';
import type { TaskService } from './task-service.ts';

export class RecoveryService {
  private operation?: Promise<unknown>;
  private receipts = new Map<string, { action: string; result: Promise<unknown> }>();
  private tasks: TaskService;
  constructor(tasks: TaskService) { this.tasks = tasks; }
  async status() {
    const tasks = this.tasks.list();
    const device = await this.tasks.device().catch(() => null);
    const blocked = tasks.filter(blocksExecution);
    const current = blocked.filter(t => !t.takeover?.released);
    const checking = current.find(t => ['running', 'stopping'].includes(t.recheck?.state ?? ''));
    const running = current.find(t => ['accepted', 'running', 'stopping'].includes(t.state));
    let state = 'ready'; let actions: string[] = []; let target: string | null = null;
    let message = '游戏环境可用。已保存的调整需求将重新准备方案，刷图仍需确认。';
    if (this.tasks.closing || this.tasks.storageFailed) {
      state = 'unavailable'; message = '服务正在退出或记录不可写。请查看启动窗口中的记录，修复存储后重新启动。';
    } else if (this.tasks.restarting) {
      state = 'reconnecting'; message = '正在结束本次执行服务并重新连接，请等待。';
    } else if (checking || device?.recovery?.state === 'running') {
      state = 'checking'; actions = ['cancel']; target = checking?.id ?? null;
      message = '正在检查首页或关卡准备页，不会刷图。检查有时限，可取消。';
      if (Date.now() / 1000 - (checking?.updated_at ?? device?.recovery?.started_at ?? 0) > 30) actions.push('reconnect');
    } else if (running) {
      state = 'stopping'; target = running.id; actions = ['stop'];
      message = running.stop_requested ? '已请求停止，等待执行端确认。' : '当前任务正在执行，可先停止再恢复环境。';
      if (running.stop_requested && Date.now() / 1000 - (running.updated_at ?? 0) > 10) actions.push('reconnect');
    } else if (!device || this.tasks.exited) {
      state = 'unconfirmed'; actions = ['reconnect']; message = '执行端连接中断。可结束本次执行服务并重新连接，再核对游戏画面。';
    } else if (tasks.some(t => t.state !== 'rejected' && (!t.sync.available || t.gap || t.evidence_conflict))) {
      state = 'evidence_unavailable'; message = '执行证据尚未同步完整，正在重新读取。若持续不恢复，请查看启动窗口中的记录。';
      actions = ['reconnect'];
    } else if (device.recoverable) {
      state = 'needs_check'; actions = ['check'];
      message = '请先停止其他自动化，将游戏留在首页或关卡准备页，再检查环境。旧任务结果会保留。';
    } else if (current.length && !tasks.some(blocksProbe) && (!device.recovery || device.recovery.automation_stopped)) {
      state = 'needs_check'; actions = ['check']; target = current[0]!.id;
      message = '自动化已停止。请等待游戏内战斗结束或手动处理现场，回到首页或关卡准备页，再检查环境。';
    } else if (blocked.length || device.admission.state !== 'ready') {
      state = 'unconfirmed'; actions = ['reconnect']; message = '执行或检查停止尚未确认。请结束本次执行服务并重新连接，再准备游戏画面。';
    }
    if (!this.tasks.restartExecutor) actions = actions.filter(a => a !== 'reconnect');
    const lastCheck = checking?.recheck ?? current.find(t => t.recheck)?.recheck ?? device?.recovery ?? null;
    return { state, message, actions, target, taskIds: blocked.map(t => t.id), lastCheck, device };
  }
  async act(id: string, action: string) {
    taskId(id);
    const old = this.receipts.get(id);
    if (old) {
      if (old.action !== action) throw new TaskError(409, 'recovery_id_conflict');
      return old.result;
    }
    if (this.operation) throw new TaskError(409, 'recovery_in_progress');
    const result = this.perform(id, action);
    this.receipts.set(id, { action, result });
    this.operation = result;
    try { return await result; } finally { this.operation = undefined; }
  }
  private async perform(id: string, action: string) {
    await this.tasks.poll();
    const state = await this.status();
    if (!state.actions.includes(action)) throw new TaskError(409, 'recovery_preconditions_changed');
    if (action === 'reconnect') await this.tasks.restartExecutor!();
    else if (action === 'stop') await this.tasks.stop(state.target!);
    else if (action === 'cancel') {
      if (state.target) await this.tasks.stop(state.target);
      else await this.tasks.adapter.call('/takeovers/stop', 'POST');
    } else if (action === 'check') {
      if (state.target) await this.tasks.recheck(state.target, { id });
      else await this.tasks.takeover({ id, confirmed: true, targets: state.device!.blockers.map(({ id, seq }) => ({ id, seq })) });
    }
    return this.status();
  }
}

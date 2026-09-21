import { useEffect, useState } from 'react';
import { api, failure, pathId } from './api';
import type { PlanView, BusinessTask, EvidencePage } from './api';
import type { WorkspaceState } from './useWorkspace';
import type { Evidence } from '../../../backend/src/task-contract';
import { TaskSummary } from './TaskSummary';
import { planTitle, time } from './presentation';

export function DetailPanel({ state }: { state: WorkspaceState }) {
  const selection = state.selection!;
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [task, setTask] = useState<BusinessTask | null>(null);
  const [events, setEvents] = useState<Evidence[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false; let timer: ReturnType<typeof setTimeout>; let after = 0;
    setPlan(null); setTask(null); setEvents([]); setError('');
    async function read() {
      try {
        if (selection.type === 'plan') {
          const result = await api<PlanView>(`/plans/${pathId(selection.id)}`); if (!cancelled) setPlan(result);
        } else {
          const result = await api<BusinessTask>(`/tasks/${pathId(selection.id)}`); if (cancelled) return; setTask(result);
          let more = true;
          while (more && !cancelled) {
            const page = await api<EvidencePage>(`/tasks/${pathId(selection.id)}/events?after=${after}`);
            if (cancelled) return;
            setEvents(old => [...old, ...page.events]); after = page.nextAfter; more = page.hasMore;
          }
          if (result.planId) { const linked = await api<PlanView>(`/plans/${pathId(result.planId)}`); if (!cancelled) setPlan(linked); }
        }
        if (!cancelled) setError('');
      } catch (e) { if (!cancelled) setError(failure(e)); }
      if (!cancelled) timer = setTimeout(read, 900);
    }
    void read(); return () => { cancelled = true; clearTimeout(timer); };
  }, [selection.id, selection.type]);
  const owner = state.status?.conversations.find(c => c.id === selection.conversationId)?.title ?? '历史工程任务';
  const cached = task && state.tasks[task.id];
  const shownTask = cached && task && (cached.task.seq > task.task.seq ||
    (cached.task.seq === task.task.seq && cached.task.stop_requested)) ? cached : task;
  return <aside className="m-details" aria-label="详情">
    <div className="m-record-label">来自{selection.conversationId === state.conversationId ? '当前会话' : `会话「${owner}」`}</div>
    <h2>{selection.type === 'plan' ? '方案依据' : '执行过程'}</h2>
    {selection.conversationId && selection.conversationId !== state.conversationId && <div className="m-warning"><p>正在查看另一个会话的对象。</p><button onClick={() => state.select(selection.conversationId)}>前往所属会话</button></div>}
    {error && <p className="m-warning">{error}</p>}
    {!plan && !task && !error && <p>正在读取详情…</p>}
    {shownTask && <TaskSummary task={shownTask} state={state} compact />}
    {plan && <>
      <h3>{selection.type === 'task' ? '关联方案' : '方案'} · v{plan.revision}</h3><p>{planTitle(plan)}</p>
      <p>{plan.explanation}</p>
      {plan.observation && <><h3>库存扫描</h3><p>{time(plan.observation.observedAt)}；{plan.observation.reliable ? '可靠识别' : '可靠性待核对'}。</p><p>初始库存 {plan.initialInventory ?? '未知'}，本次缺口 {plan.quantity}。</p></>}
      <h3>资料来源</h3>
      {Object.entries(plan.sources).map(([name, source]) => <p key={name}><a href={source.url} target="_blank" rel="noreferrer">{name}</a><br /><span className="m-small">版本 {source.revision}<br />获取时间 {time(source.fetchedAt)}</span></p>)}
      <p className="m-small">资料版本 {plan.catalogVersion}。账号解锁、代理与当前开放条件仍需满足，不保证当前效率最优。</p>
      {(plan.relatedTasks ?? plan.previousTasks).length > 0 && <><h3>调整关系</h3><p>{plan.adjustment === 'additional' ? '另加目标，旧成果不抵扣本次目标。' : '总目标调整，核算依据以本方案保存的旧成果为准。'}</p>{(plan.relatedTasks ?? plan.previousTasks).map(taskId => <button className="m-link" key={taskId} onClick={() => state.inspect({ type: 'task', id: taskId, conversationId: plan.conversationId })}>查看旧任务 {taskId}</button>)}</>}
    </>}
    {task?.task.inventory_result && <><h3>识别数量</h3>{Object.entries(task.task.inventory_result.items).map(([item, count]) => <p key={item}>{item}：{count}</p>)}<p className="m-small">未识别项为未知。</p></>}
    {selection.type === 'task' && <><h3>关键记录</h3><ol className="m-events">{events.map(event => <li key={event.seq}><span className="m-small">#{event.seq} · {time(event.snapshot.updated_at)}</span><p>{event.kind}</p><p className="m-small">{event.snapshot.state} · 已确认成功次数 {event.snapshot.certainty === 'lower_bound' ? '至少 ' : ''}{event.snapshot.confirmed}</p>
      {event.snapshot.material_result && <p className="m-small">累计材料反馈：{Object.entries(event.snapshot.material_result.items).map(([item, count]) => `${item} ${count}`).join('，')}（{event.snapshot.material_result.certainty}）</p>}</li>)}</ol>{!events.length && <p className="m-small">尚无已保存的执行事件。</p>}</>}
    <p className="m-small">对象 ID：{selection.id}</p>
  </aside>;
}

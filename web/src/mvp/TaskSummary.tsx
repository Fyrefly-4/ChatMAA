import type { BusinessTask } from './api';
import type { WorkspaceState } from './useWorkspace';
import { amount, execution, planTitle, processText, reasonText, targetText, time } from './presentation';
import { ProgressTime } from './ProgressTime';

export function TaskSummary({ task: t, state, compact = false }: { task: BusinessTask; state: WorkspaceState; compact?: boolean }) {
  const result = t.result; const snapshot = t.task;
  const scan = t.purpose === 'inventory' || ('kind' in snapshot.params && snapshot.params.kind === 'scan_inventory');
  const active = !snapshot.automation_stopped && snapshot.state !== 'rejected';
  const progressing = active && snapshot.state !== 'unknown' && snapshot.sync.available && !snapshot.gap && !snapshot.evidence_conflict;
  return <section className={`m-task ${compact ? 'm-task-compact' : ''}`} aria-label={scan ? '库存扫描任务' : '刷图任务'}>
    <div className="m-record-label"><span>任务记录</span><span>{execution(t)}</span></div>
    <h2>{scan ? '库存扫描' : t.plan ? `目标：${planTitle(t.plan)}` : `${'stage' in snapshot.params ? snapshot.params.stage : '刷图'} · 执行记录`}</h2>
    {active && <><p>{snapshot.stop_requested ? '已请求停止，等待执行端确认。' : !progressing ? '执行状态待核对，保留最后已知成果。' : scan ? (snapshot.state === 'running' ? '正在扫描库存，等待识别结果。' : '扫描已受理，等待执行端开始。') : '任务仍在执行，最终数量以结束反馈为准。'}</p><ProgressTime since={snapshot.stop_requested ? t.stopRequestedAt : t.startedAt} label={snapshot.stop_requested ? '停止请求' : scan ? '扫描任务' : '任务'} /></>}
    {result ? <>
      <p>{t.summary ?? `${processText[result.process]} · ${targetText[result.target]}`}</p>
      <div className="m-metrics"><div><strong>{progressing && result.amount.certainty !== 'unknown' && result.amount.value !== null ? result.amount.value : amount(result.amount)}</strong><small>{t.plan?.goal.kind === 'count' ? '已确认成功次数' : '已确认材料收获'}</small></div>
        {result.estimatedInventory && <div><strong>{amount(result.estimatedInventory)}</strong><small>推算库存</small></div>}
        {result.remaining !== null && <div><strong>{result.remaining}</strong><small>剩余目标量</small></div>}
      </div>
      {result.initialInventory !== null && <p className="m-small">初始库存 {result.initialInventory}；推算库存，未重新扫描。</p>}
      {result.cumulative.value !== result.amount.value && <p className="m-small">关联任务累计成果：{amount(result.cumulative)}。</p>}
      {result.amount.certainty !== 'exact' && !active && <p className="m-warning">任务已结束，但另有结果未确认，不能给出精确剩余量。</p>}
      {active && snapshot.unsettled_cycles > 0 && <p className="m-small">另有 {snapshot.unsettled_cycles} 个批次尚未结算。</p>}
    </> : scan ? <p>{snapshot.inventory_result ? `库存识别${snapshot.inventory_result.complete ? '已完成' : '不完整'}；${snapshot.inventory_result.certainty === 'recognized' ? '可靠数量见详情' : '未知项不按零处理'}` : '等待执行端库存反馈。'}</p> : <p>历史工程或 Demo 任务，未关联 MVP 方案；已确认成功次数 {snapshot.certainty === 'lower_bound' ? '至少 ' : ''}{snapshot.confirmed}。</p>}
    {snapshot.reason && <p className="m-small">结束／状态原因：{reasonText[snapshot.reason] ?? snapshot.reason}</p>}
    <p className="m-small">环境：{snapshot.device === 'ready' ? '可用' : '待核对'} · 最后事实 {time(snapshot.updated_at)}</p>
    <p className="m-small">最近成功同步：{time(snapshot.sync.last_success_at)}{scan && !active ? '；识别结果见任务详情，未识别项目仍为未知。' : ''}</p>
    {!snapshot.sync.available && <p className="m-warning">执行反馈同步不可用，显示最后已知事实。</p>}
    {(snapshot.gap || snapshot.evidence_conflict) && <p className="m-warning">执行证据有缺口或冲突，需进一步核实。</p>}
    <div className="m-actions">
      {!snapshot.automation_stopped && snapshot.state !== 'rejected' && <button disabled={!!state.actions[`stop.${t.id}`]} onClick={() => void state.stop(t)}>{state.actions[`stop.${t.id}`] ? '正在请求停止…' : '停止任务'}</button>}
      {!compact && <button className="m-link" onClick={() => state.inspect({ type: 'task', id: t.id, conversationId: t.conversationId ?? '' })}>查看任务详情 →</button>}
    </div>
  </section>;
}

import type { BusinessTask } from './api';
import type { WorkspaceState } from './useWorkspace';
import { amount, execution, planTitle, processText, reasonText, targetText, time } from './presentation';

export function TaskSummary({ task: t, state, compact = false }: { task: BusinessTask; state: WorkspaceState; compact?: boolean }) {
  const result = t.result; const snapshot = t.task;
  const scan = t.purpose === 'inventory' || ('kind' in snapshot.params && snapshot.params.kind === 'scan_inventory');
  return <section className={`m-task ${compact ? 'm-task-compact' : ''}`} aria-label={scan ? '库存扫描任务' : '刷图任务'}>
    <div className="m-record-label"><span>任务记录</span><span>{execution(t)}</span></div>
    <h2>{scan ? '库存扫描' : t.plan ? planTitle(t.plan) : `${'stage' in snapshot.params ? snapshot.params.stage : '刷图'} · 执行记录`}</h2>
    {result ? <>
      <p>{processText[result.process]} · {targetText[result.target]}</p>
      <div className="m-metrics"><div><strong>{amount(result.amount)}</strong><small>{t.plan?.goal.kind === 'count' ? '本次成功次数' : '本次材料收获'}</small></div>
        {result.estimatedInventory && <div><strong>{amount(result.estimatedInventory)}</strong><small>推算库存</small></div>}
        {result.remaining !== null && <div><strong>{result.remaining}</strong><small>剩余目标量</small></div>}
      </div>
      {result.initialInventory !== null && <p className="m-small">初始库存 {result.initialInventory}；推算库存，未重新扫描。</p>}
      {result.cumulative.value !== result.amount.value && <p className="m-small">关联任务累计成果：{amount(result.cumulative)}。</p>}
      {result.amount.certainty !== 'exact' && <p className="m-warning">完成量含未知部分，不能给出精确剩余或据此自动补刷。</p>}
    </> : scan ? <p>{snapshot.inventory_result ? `库存识别${snapshot.inventory_result.complete ? '已完成' : '不完整'}；${snapshot.inventory_result.certainty === 'exact' ? '可靠数量见详情' : '未知项不按零处理'}` : '等待执行端库存反馈。'}</p> : <p>历史工程或 Demo 任务，未关联 MVP 方案；已确认成功次数 {snapshot.certainty === 'lower_bound' ? '至少 ' : ''}{snapshot.confirmed}。</p>}
    {snapshot.reason && <p className="m-small">结束／状态原因：{reasonText[snapshot.reason] ?? snapshot.reason}</p>}
    <p className="m-small">环境：{snapshot.device === 'ready' ? '可用' : '待核对'} · 最后事实 {time(snapshot.updated_at)}</p>
    {!snapshot.sync.available && <p className="m-warning">执行反馈同步不可用，显示最后已知事实。</p>}
    {(snapshot.gap || snapshot.evidence_conflict) && <p className="m-warning">执行证据有缺口或冲突，需进一步核实。</p>}
    <div className="m-actions">
      {!snapshot.automation_stopped && snapshot.state !== 'rejected' && <button disabled={!!state.actions[`stop.${t.id}`]} onClick={() => void state.stop(t)}>{state.actions[`stop.${t.id}`] ? '正在请求停止…' : '停止任务'}</button>}
      {!compact && <button className="m-link" onClick={() => state.inspect({ type: 'task', id: t.id, conversationId: t.conversationId ?? '' })}>查看任务详情 →</button>}
    </div>
  </section>;
}

import { useEffect, useRef, useState } from 'react';
import type { PlanView } from './api';
import { api, pathId } from './api';
import type { WorkspaceState } from './useWorkspace';
import { planTitle, planStates, time } from './presentation';

export function PlanCard({ plan: p, state, current }: { plan: PlanView; state: WorkspaceState; current: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const [displayFailed, setDisplayFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const canPresent = current && ['unpresented', 'presented'].includes(p.state);
  const canEdit = current && ['unpresented', 'presented', 'stale'].includes(p.state);
  useEffect(() => {
    if (!canPresent || p.presentation?.lastMessageId !== undefined) return;
    let cancelled = false; let visible = false; let frame = 0;
    function display() {
      if (cancelled || !visible || document.visibilityState !== 'visible') return;
      frame = requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!cancelled && visible && document.visibilityState === 'visible') void state.present(p).catch(() => { if (!cancelled) setDisplayFailed(true); });
      }));
    }
    const observer = new IntersectionObserver(entries => { visible = entries.some(e => e.isIntersecting); if (visible) display(); });
    if (ref.current) observer.observe(ref.current);
    document.addEventListener('visibilitychange', display);
    return () => { cancelled = true; observer.disconnect(); cancelAnimationFrame(frame); document.removeEventListener('visibilitychange', display); };
  }, [p.id, canPresent, p.presentation?.id, retry]);
  const estimate = p.estimate as { sanity?: number | null; reason?: string } | null;
  const busy = !!state.actions[`confirm.${p.id}`];
  const blocked = state.status?.admission.state !== 'ready' || state.status.device?.admission.state !== 'ready';
  if (!canEdit && !expanded) return <div className="m-plan-history">
    <span className="m-small">方案 v{p.revision} · {planStates[p.state]}</span>
    <p>{planTitle(p)}</p>
    <div className="m-actions"><button className="m-link" onClick={() => setExpanded(true)}>展开历史方案</button><button className="m-link" onClick={() => state.inspect({ type: 'plan', id: p.id, conversationId: p.conversationId })}>查看依据 →</button></div>
  </div>;
  return <section className="m-plan" ref={ref} aria-label={`执行方案 ${p.revision}`}>
    <div className="m-record-label"><span>执行方案 · v{p.revision}</span><span>{planStates[p.state]}</span></div>
    <h2>{planTitle(p)}</h2>
    <div className="m-metrics">
      {p.goal.kind === 'inventory' && <><div><strong>{p.initialInventory ?? '未知'}</strong><small>扫描库存</small></div><div><strong>{p.quantity}</strong><small>本次缺口</small></div></>}
      {p.goal.kind === 'material' && <div><strong>{p.quantity}</strong><small>本次材料目标</small></div>}
      {p.goal.kind === 'count' && <div><strong>{p.quantity}</strong><small>成功次数目标</small></div>}
      <div><strong>{p.stage}</strong><small>选定关卡</small></div>
    </div>
    {p.previousTasks.length > 0 && <p>关联旧任务；本次计划 {p.quantity}，原目标 {p.goal.quantity}。旧成果保留在任务记录中。</p>}
    <p className="m-small">依据：{p.explanation}</p>
    {p.observation && <p className="m-small">库存扫描完成于 {time(p.observation.observedAt)}，{p.observation.reliable ? '可靠识别' : '可靠性待核实'}。</p>}
    <p>仅使用现有理智，不使用理智药或源石。</p>
    <p className="m-small">{estimate?.sanity != null ? `参考理智消耗约 ${Number(estimate.sanity.toFixed(1))}。` : ''}{estimate?.reason ?? '无法可靠估算。'}未读取当前理智，可能部分完成。</p>
    <p className="m-small">达到目标、理智不足、用户停止或执行异常时结束。</p>
    {p.limitations.map((line, i) => <p className="m-small" key={i}>{line}</p>)}
    <div className="m-actions">
      {canEdit && <>
        <button className="m-primary" disabled={!canPresent || !p.presentation || busy || blocked || !!state.connection} onClick={() => void state.confirm(p)}>
          {!canPresent ? '方案依据需要更新' : busy ? '正在提交确认…' : blocked ? '环境占用或待核对' : !p.presentation ? '正在登记展示…' : '确认并开始'}
        </button>
        <button className="m-link" onClick={() => { state.draft('我想修改这个方案：'); document.getElementById('m-composer')?.focus(); }}>修改方案</button>
        <button className="m-link" disabled={!!state.actions[`cancel.${p.id}`]} onClick={() => void state.action(`cancel.${p.id}`, () => api(`/requests/${pathId(p.requestId)}/cancel`, { revision: p.revision }))}>取消方案</button>
      </>}
      <button className="m-link" onClick={() => state.inspect({ type: 'plan', id: p.id, conversationId: p.conversationId })}>查看依据 →</button>
      {!canPresent && <button className="m-link" onClick={() => setExpanded(false)}>收起历史方案</button>}
    </div>
    {canPresent && blocked && <p className="m-small">未加入队列。环境释放后，需要你再次发起开始。</p>}
    {displayFailed && !p.presentation && <button onClick={() => { setDisplayFailed(false); setRetry(v => v + 1); }}>重新登记本方案展示</button>}
  </section>;
}

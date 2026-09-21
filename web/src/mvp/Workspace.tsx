import { useEffect, useRef, useState } from 'react';
import { useWorkspace } from './useWorkspace';
import { PlanCard } from './PlanCard';
import { TaskSummary } from './TaskSummary';
import { DetailPanel } from './DetailPanel';
import { AssistantMessage } from './AssistantMessage';
import { MessageActivity } from './MessageActivity';
import { api, id, pathId } from './api';
import { execution, waitingText } from './presentation';
import './workspace.css';

export default function Workspace() {
  const state = useWorkspace(); const status = state.status;
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [manual, setManual] = useState(false);
  const [newContent, setNewContent] = useState(false);
  const stream = useRef<HTMLDivElement>(null); const atBottom = useRef(true);
  const previousLength = useRef(0); const historyAnchor = useRef<number | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null); const detailsButton = useRef<HTMLButtonElement>(null);
  const blockers = status?.tasks ?? [];
  const abnormal = !!state.connection || !status?.adapterAvailable || !status?.device || !status.projection.available || !!status.storageFailed ||
    blockers.some(t => !t.task.sync.available || t.task.state === 'unknown' || (t.task.automation_stopped && t.task.device !== 'ready'));
  const currentPlan = state.conversation?.currentPlan ? state.plans[state.conversation.currentPlan] ?? state.conversation.plan : null;
  const latestTurn = Object.values(state.turns).sort((a, b) => b.generation - a.generation)[0];
  const latestActivity = latestTurn ? state.activities[latestTurn.id]?.at(-1) : null;
  useEffect(() => {
    atBottom.current = true; previousLength.current = 0; setNewContent(false);
  }, [state.conversationId]);
  useEffect(() => {
    const element = stream.current; if (!element) return;
    if (historyAnchor.current !== null) {
      element.scrollTop += element.scrollHeight - historyAnchor.current; historyAnchor.current = null;
    } else if (atBottom.current) element.scrollTop = element.scrollHeight;
    else if (state.messages.length > previousLength.current) setNewContent(true);
    previousLength.current = state.messages.length;
  }, [state.messages.length, currentPlan?.id]);
  function closeDetail() { state.inspect(null); detailsButton.current?.focus(); }
  const referencedPlans = new Set(state.messages.flatMap(m => m.reference && state.plans[m.reference] ? [m.reference] : []));
  const referencedTasks = new Set(state.messages.flatMap(m => m.reference && state.tasks[m.reference] ? [m.reference] : []));
  const renderedTasks = new Set<string>();
  // Execution may finish before a result message exists, including projection failures.
  const ownTasks = Object.values(state.tasks).filter(t => t.conversationId === state.conversationId && !referencedTasks.has(t.id));
  const title = status?.conversations.find(c => c.id === state.conversationId)?.title ?? '开始一段对话';
  return <main className={`mvp ${state.selection ? 'm-has-details' : ''}`}>
    <nav className="m-nav" aria-label="会话列表">
      <div className="m-brand">Chat<span>MAA</span></div>
      <button className="m-new" disabled={state.sending || !!state.connection || !!status?.closing} onClick={() => void state.create()}>＋ 新会话</button>
      <span className="m-small m-nav-label">会话</span>
      <div className="m-conversations">{status?.conversations.map((conversation, index) => <button key={conversation.id} aria-current={state.conversationId === conversation.id ? 'page' : undefined} onClick={() => state.select(conversation.id)}>
        <span>{conversation.title === '新会话' ? `会话 ${index + 1}` : conversation.title}</span>
        <small>{state.updatedConversations.includes(conversation.id) ? '任务结果有更新' : blockers.some(t => t.conversationId === conversation.id) ? '任务进行中或待核对' : conversation.currentPlan ? '方案与记录' : '对话'}</small>
      </button>)}</div>
    </nav>
    <section className="m-work">
      <header className="m-header">
        <div className="m-heading"><span>{title}</span><button ref={detailsButton} className="m-link" onClick={() => state.selection ? closeDetail() : currentPlan ? state.inspect({ type: 'plan', id: currentPlan.id, conversationId: currentPlan.conversationId }) : blockers[0] ? state.inspect({ type: 'task', id: blockers[0].id, conversationId: blockers[0].conversationId ?? '' }) : state.setNotice('从方案或任务记录打开对应详情。')}>{state.selection ? '收起详情' : '查看详情'}</button></div>
        <div className="m-global">
          <div className="m-global-tasks">{blockers.length ? blockers.map(task => <div key={task.id}>
            <span>{execution(task)} · 所属会话：{status?.conversations.find(c => c.id === task.conversationId)?.title ?? '历史工程任务'}</span>
            {task.conversationId && task.conversationId !== state.conversationId && <button className="m-link" onClick={() => state.select(task.conversationId!)}>前往所属会话</button>}
            <button className="m-link" onClick={() => state.inspect({ type: 'task', id: task.id, conversationId: task.conversationId ?? '' })}>任务详情</button>
            {!task.task.automation_stopped && <button disabled={!!state.actions[`stop.${task.id}`]} onClick={() => void state.stop(task)}>停止任务</button>}
          </div>) : <span>{status?.admission.state === 'ready' && status.device?.admission.state === 'ready' ? '游戏环境可用' : '正在核对游戏环境'}</span>}</div>
          <button className="m-link" aria-expanded={connectionsOpen || abnormal} onClick={() => setConnectionsOpen(v => !v)}>{abnormal ? '连接或环境需关注' : '▸ 连接正常'}</button>
        </div>
        {(connectionsOpen || abnormal) && <div className="m-connections">
          <p>页面与后台：{state.connection || (status ? '连接正常' : '正在连接')}</p>
          <p>执行端：{status?.adapterAvailable && status.device ? '可读取状态' : '连接待核对'}；游戏环境：{status?.device?.admission.state === 'ready' ? '可用' : '占用或待核对'}。</p>
          {blockers.some(t => !t.task.sync.available) && <p>执行反馈同步异常，任务卡保留最后已知成果与更新时间。</p>}
          <p>业务投影：{status?.projection.available ? '可用' : status?.projection.reason ?? '尚未读取'}；模型：{status?.runtime.available ? '可用' : '不可用，已有任务仍可查询和停止'}。</p>
          <p>执行来源：{status?.mode === 'offline_callback_replay' ? '离线回放，不操作游戏' : status?.mode ?? '尚未读取'}。</p>
          {status?.closing && <p>后台正在退出并交接执行证据。</p>}
          {blockers.some(t => t.task.automation_stopped && t.task.device !== 'ready') && <p>自动化已停止不等于游戏内战斗结束。请接管现场并核对；环境放行不改写旧未知成果。</p>}
          {blockers.filter(t => t.task.automation_stopped && t.task.device !== 'ready').map(task => <button key={task.id} disabled={!!state.actions[`recheck.${task.id}`]} onClick={() => void state.action(`recheck.${task.id}`, () => api(`/tasks/${pathId(task.id)}/recheck`, { id: id() }))}>核对任务环境</button>)}
          {status?.device?.recoverable && <div className="m-recovery"><label><input type="checkbox" checked={manual} onChange={e => setManual(e.target.checked)} />我已停止其他自动化、接管游戏并准备好界面</label>
            <button disabled={!manual || !!state.actions.takeover} onClick={() => void state.action('takeover', async () => {
              await api('/takeovers', { id: id(), confirmed: true, targets: status.device!.blockers.map(b => ({ id: b.id, seq: b.seq })) }); setManual(false);
            })}>核对环境并恢复使用</button></div>}
        </div>}
      </header>
      <div className="m-body">
        <section className="m-chat" aria-label="当前对话">
          <div className="m-stream" ref={stream} onScroll={() => { const e = stream.current!; atBottom.current = e.scrollHeight - e.scrollTop - e.clientHeight < 70; if (atBottom.current) setNewContent(false); }}>
            {state.before && <button className="m-link m-history" disabled={state.loadingHistory} onClick={() => { historyAnchor.current = stream.current?.scrollHeight ?? null; void state.older(); }}>加载更早记录</button>}
            {!state.conversationId && <div className="m-empty"><h1>把需求交给助手</h1><p>先新建会话，可以咨询，也可以提出刷取目标。</p><button onClick={() => void state.create()}>新建会话</button></div>}
            {state.conversationId && !state.conversation && <p>正在读取会话…</p>}
            {state.conversation && !state.messages.length && <div className="m-empty"><h1>从一个目标开始</h1><p>讨论需求、阅读方案，再由你确认开始。</p>{['帮我把固源岩补到 100 个', '再获得 20 个固源岩', '刷 1-7 五次'].map(example => <button className="m-example" key={example} onClick={() => { state.draft(example); composer.current?.focus(); }}>{example}</button>)}</div>}
            {state.messages.map(message => {
              const plan = message.reference ? state.plans[message.reference] : null;
              const task = message.reference ? state.tasks[message.reference] : null;
              const showTask = task && !renderedTasks.has(task.id); if (task) renderedTasks.add(task.id);
              return <div key={message.id} className="m-message-group">
                {message.role === 'assistant' ? <AssistantMessage text={message.text} />
                  : <p className={message.role === 'user' ? 'm-user' : 'm-system'}>{message.text}</p>}
                {message.role === 'user' && <MessageActivity conversationId={message.conversationId} messageId={message.id} />}
                {plan && <PlanCard plan={plan} current={plan.id === currentPlan?.id} state={state} />}
                {showTask && <TaskSummary task={task} state={state} />}
              </div>;
            })}
            {currentPlan && !referencedPlans.has(currentPlan.id) && <PlanCard plan={currentPlan} current state={state} />}
            {ownTasks.map(task => <TaskSummary key={task.id} task={task} state={state} />)}
            {state.conversation?.request?.waiting.length ? <p className="m-activity">当前等待：{state.conversation.request.waiting.map(w => waitingText[w] ?? w).join('、')}</p> : null}
            {latestTurn && <div className="m-activity" role="status">{latestTurn.state === 'processing' ? latestActivity?.kind === 'tool_call' ? '助手正在处理业务操作…' : '助手正在理解与处理…' : latestTurn.state === 'completed' ? '本轮回复已结束，任务执行状态独立更新。' : `本轮${latestTurn.state === 'failed' ? '处理失败' : '已中断'}：${latestTurn.reason ?? '原因待核对'}。已受理任务不因此撤销。`}</div>}
          </div>
          {newContent && <button className="m-new-content" onClick={() => { stream.current?.scrollTo({ top: stream.current.scrollHeight, behavior: 'smooth' }); atBottom.current = true; setNewContent(false); }}>查看新内容 ↓</button>}
          <div className="m-composer-area">
            {state.notice && <p className="m-notice" role="status">{state.notice}</p>}
            {state.pending?.conversationId === state.conversationId && <p className="m-warning">原消息正在核对受理结果，不会自动重新发送。</p>}
            <form className="m-composer" onSubmit={e => { e.preventDefault(); void state.send(); }}>
              <textarea id="m-composer" ref={composer} aria-label="消息" value={state.conversationId ? state.drafts[state.conversationId] ?? '' : ''}
                disabled={!state.conversationId} placeholder="继续讨论，或告诉我你想调整什么…" rows={2} onChange={e => state.draft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (!e.currentTarget.form?.querySelector<HTMLButtonElement>('button[type=submit]')?.disabled) void state.send(); } }} />
              <div><span className="m-small">仅用现有理智 · 不吃药、不碎石</span><button type="submit" className="m-primary" disabled={!state.conversationId || !state.drafts[state.conversationId]?.trim() || state.sending || !!state.connection || !status?.runtime.available || !!status.closing || !status.projection.available || state.pending?.conversationId === state.conversationId}>{state.sending ? '发送中…' : '发送'}</button></div>
            </form>
          </div>
        </section>
        {state.selection && <DetailPanel state={state} />}
      </div>
    </section>
  </main>;
}

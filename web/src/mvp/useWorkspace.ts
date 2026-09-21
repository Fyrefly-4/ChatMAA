import { useEffect, useRef, useState } from 'react';
import { api, failure, id, pathId, saved, save, ApiError } from './api';
import type { MvpStatus, MvpConversation, Message, PlanView, BusinessTask, Turn, Activity, MessagePage, TurnPage, Presentation } from './api';

export type Selection = { type: 'plan' | 'task'; id: string; conversationId: string };
type Pending = { conversationId: string; messageId: string; text: string };
function mergeTasks(old: Record<string, BusinessTask>, incoming: BusinessTask[]) {
  const next = { ...old };
  for (const task of incoming) {
    const previous = old[task.id];
    if (previous && (previous.task.seq > task.task.seq ||
      (previous.task.stop_requested && !task.task.stop_requested && !task.task.automation_stopped))) continue;
    next[task.id] = task;
  }
  return next;
}
export function useWorkspace() {
  const [conversationId, choose] = useState(() => saved<string | null>('conversation', null));
  const [status, setStatus] = useState<MvpStatus | null>(null);
  const [conversation, setConversation] = useState<MvpConversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [plans, setPlans] = useState<Record<string, PlanView>>({});
  const [tasks, setTasks] = useState<Record<string, BusinessTask>>({});
  const [turns, setTurns] = useState<Record<string, Turn>>({});
  const [activities, setActivities] = useState<Record<string, Activity[]>>({});
  const [before, setBefore] = useState<string | null>(null);
  const [drafts, setDrafts] = useState(() => saved<Record<string, string>>('drafts', {}));
  const [selection, setSelection] = useState<Selection | null>(() => conversationId ? saved<Selection | null>(`detail.${conversationId}`, null) : null);
  const [connection, setConnection] = useState('');
  const [notice, setNotice] = useState('');
  const [updatedConversations, setUpdatedConversations] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [pending, setPending] = useState<Record<string, Pending>>(() => saved<Record<string, Pending>>('pendingMessages', {}));
  const [actions, setActions] = useState<Record<string, boolean>>({});
  const selected = useRef(conversationId); selected.current = conversationId;
  const taskCache = useRef(tasks); taskCache.current = tasks;
  const detail = useRef(selection); detail.current = selection;
  const pendingRef = useRef(pending); pendingRef.current = pending;
  const presentations = useRef(new Map<string, Promise<Presentation>>());
  const sendingLock = useRef(false); const actionLocks = useRef(new Set<string>());
  function markPending(cid: string, value: Pending | null) {
    const next = { ...pendingRef.current }; if (value) next[cid] = value; else delete next[cid];
    pendingRef.current = next; setPending(next); save('pendingMessages', next);
  }

  function select(value: string) {
    save('conversation', value); choose(value);
    setSelection(saved<Selection | null>(`detail.${value}`, null));
    setNotice('');
    setUpdatedConversations(old => old.filter(cid => cid !== value));
  }
  function inspect(value: Selection | null) { setSelection(value); if (conversationId) save(`detail.${conversationId}`, value); }
  function draft(text: string) {
    if (!conversationId) return;
    setDrafts(old => { const next = { ...old, [conversationId]: text }; save('drafts', next); return next; });
  }
  function mergePage(page: MessagePage, older = false) {
    setMessages(old => {
      const map = new Map((older ? [...page.messages, ...old] : [...old, ...page.messages]).map(m => [m.id, m]));
      return [...map.values()];
    });
    setPlans(old => ({ ...old, ...Object.fromEntries(page.plans.map(p => [p.id, p])) }));
    setTasks(old => mergeTasks(old, page.tasks));
  }
  useEffect(() => {
    let cancelled = false; let timer: ReturnType<typeof setTimeout>;
    const previousTasks = new Map<string, string | undefined>();
    async function poll() {
      try {
        const next = await api<MvpStatus>('/status'); if (cancelled) return;
        for (const [taskId, owner] of previousTasks) {
          if (!next.tasks.some(t => t.id === taskId) && owner && owner !== selected.current) {
            setNotice('另一会话的任务状态已更新，可从会话列表回看结果。');
            setUpdatedConversations(old => [...new Set([...old, owner])]);
          }
        }
        previousTasks.clear(); for (const task of next.tasks) previousTasks.set(task.id, task.conversationId);
        setStatus(next); setConnection('');
        setTasks(old => mergeTasks(old, next.tasks));
        if (!selected.current && next.conversations.length) select(next.conversations.at(-1)!.id);
      } catch (e) { if (!cancelled) setConnection(failure(e)); }
      if (!cancelled) timer = setTimeout(poll, 700);
    }
    void poll(); return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  useEffect(() => {
    setConversation(null); setMessages([]); setBefore(null); setTurns({}); setActivities({});
    if (!conversationId) return;
    const cid = conversationId;
    let cancelled = false; let timer: ReturnType<typeof setTimeout>;
    let after: string | undefined; let turnAfter: number | undefined;
    let previousPlan: string | null = null;
    const knownTurns = new Map<string, Turn>(); const cursors = new Map<string, number>(); const drained = new Set<string>();
    async function poll() {
      try {
        const current = await api<MvpConversation>(`/conversations/${pathId(cid)}`);
        if (cancelled) return;
        if (previousPlan && previousPlan !== current.currentPlan) {
          const oldPlan = await api<PlanView>(`/plans/${pathId(previousPlan)}`);
          if (cancelled) return;
          setPlans(old => ({ ...old, [oldPlan.id]: oldPlan }));
        }
        previousPlan = current.currentPlan;
        setConversation(current);
        if (current.plan) setPlans(old => ({ ...old, [current.plan!.id]: current.plan! }));
        setTasks(old => mergeTasks(old, current.activeTasks));
        let more = true;
        while (more && !cancelled) {
          const page = await api<MessagePage>(`/conversations/${pathId(cid)}/messages${after ? `?after=${pathId(after)}` : ''}`);
          if (cancelled) return;
          if (!after) setBefore(page.nextBefore);
          const wasInitial = after === undefined; mergePage(page); after = page.nextAfter ?? after;
          more = !wasInitial && page.hasMore;
        }
        let moreTurns = true;
        while (moreTurns && !cancelled) {
          const page = await api<TurnPage>(`/conversations/${pathId(cid)}/turns${turnAfter === undefined ? '' : `?after=${turnAfter}`}`);
          if (cancelled) return;
          const wasInitial = turnAfter === undefined;
          for (const turn of page.turns) knownTurns.set(turn.id, turn);
          turnAfter = page.nextAfter; moreTurns = !wasInitial && page.hasMore;
        }
        for (const turn of knownTurns.values()) {
          if (drained.has(turn.id)) continue;
          let moreActivities = true;
          while (moreActivities && !cancelled) {
            const view = await api<{ turn: Turn; activities: Activity[] }>(`/turns/${pathId(turn.id)}?after=${cursors.get(turn.id) ?? 0}`);
            if (cancelled) return;
            knownTurns.set(turn.id, view.turn);
            if (view.activities.length) cursors.set(turn.id, view.activities.at(-1)!.sequence);
            setActivities(old => ({ ...old, [turn.id]: [...(old[turn.id] ?? []), ...view.activities] }));
            moreActivities = view.activities.length === 100;
            if (!moreActivities && view.turn.state !== 'processing') drained.add(turn.id);
          }
        }
        if (cancelled) return;
        setTurns(Object.fromEntries(knownTurns));
        const need = Object.values(taskCache.current).filter(t => t.conversationId === cid && (!t.task.automation_stopped || t.task.state !== 'ended')).map(t => t.id);
        if (detail.current?.type === 'task') need.push(detail.current.id);
        for (const taskId of new Set(need)) {
          const task = await api<BusinessTask>(`/tasks/${pathId(taskId)}`); if (cancelled) return;
          setTasks(old => mergeTasks(old, [task]));
        }
        const uncertain = pendingRef.current[cid];
        if (uncertain) {
          try {
            await api(`/conversations/${pathId(cid)}/messages/${pathId(uncertain.messageId)}`);
            if (!cancelled && pendingRef.current[cid]?.messageId === uncertain.messageId) {
              markPending(cid, null); setNotice('已核对原消息受理记录，没有重复发送。');
              setDrafts(old => { const next = { ...old, [cid]: old[cid]?.trim() === uncertain.text ? '' : old[cid] }; save('drafts', next); return next; });
            }
          } catch (e) { if (!(e instanceof ApiError && e.status === 404)) throw e; }
        }
      } catch (e) { if (!cancelled) setNotice(failure(e)); }
      if (!cancelled) timer = setTimeout(poll, 650);
    }
    void poll(); return () => { cancelled = true; clearTimeout(timer); };
  }, [conversationId]);

  async function older() {
    if (!conversationId || !before || loadingHistory) return;
    const cid = conversationId; setLoadingHistory(true);
    try {
      const page = await api<MessagePage>(`/conversations/${pathId(cid)}/messages?before=${pathId(before)}`);
      if (selected.current === cid) { mergePage(page, true); setBefore(page.nextBefore); }
    } catch (e) { setNotice(failure(e)); } finally { setLoadingHistory(false); }
  }
  async function create() {
    const cid = id(); setSending(true);
    try { await api('/conversations', { id: cid, title: `会话 ${(status?.conversations.length ?? 0) + 1}` }); select(cid); }
    catch (e) { setNotice(failure(e)); } finally { setSending(false); }
  }
  async function send() {
    const cid = conversationId; const text = cid ? drafts[cid]?.trim() : '';
    if (!cid || !text || sendingLock.current || pendingRef.current[cid]) return;
    sendingLock.current = true; setSending(true); setNotice('');
    const messageId = id();
    try {
      if (conversation?.plan) await presentations.current.get(conversation.plan.id);
      const record = { conversationId: cid, messageId, text }; markPending(cid, record);
      await api('/messages', record);
      markPending(cid, null);
      setDrafts(old => { const next = { ...old, [cid]: old[cid]?.trim() === text ? '' : old[cid] }; save('drafts', next); return next; });
    } catch (e) {
      if (e instanceof ApiError && e.status < 500) markPending(cid, null);
      setNotice(failure(e));
    } finally { sendingLock.current = false; setSending(false); }
  }
  async function present(plan: PlanView) {
    if (plan.presentation?.lastMessageId !== undefined) return plan.presentation;
    const existing = presentations.current.get(plan.id); if (existing) return existing;
    const displayId = saved<string>(`presentation.${plan.id}`, id()); save(`presentation.${plan.id}`, displayId);
    const work = api<Presentation>(`/plans/${pathId(plan.id)}/present`, { id: displayId });
    presentations.current.set(plan.id, work);
    try {
      const receipt = await work;
      setPlans(old => ({ ...old, [plan.id]: { ...(old[plan.id] ?? plan), state: 'presented', presentation: receipt } }));
      return receipt;
    } catch (e) { presentations.current.delete(plan.id); setNotice(failure(e)); throw e; }
  }
  async function action(key: string, work: () => Promise<unknown>) {
    if (actionLocks.current.has(key)) return;
    actionLocks.current.add(key);
    setActions(old => ({ ...old, [key]: true })); setNotice('');
    try { await work(); } catch (e) { setNotice(failure(e)); }
    finally { actionLocks.current.delete(key); setActions(old => ({ ...old, [key]: false })); }
  }
  async function confirm(plan: PlanView) {
    await action(`confirm.${plan.id}`, async () => {
      const receipt = plan.presentation; if (!receipt) throw new Error('展示尚未完成');
      const confirmation = saved<string>(`confirm.${plan.id}`, id()); save(`confirm.${plan.id}`, confirmation);
      const task = await api<BusinessTask>(`/plans/${pathId(plan.id)}/confirm`, { id: confirmation, presentationId: receipt.id });
      setTasks(old => mergeTasks(old, [task]));
      setNotice('确认已交给后台，执行情况以任务事实为准。');
    });
  }
  async function stop(task: BusinessTask) {
    await action(`stop.${task.id}`, async () => {
      await api(`/tasks/${pathId(task.id)}/stop`, {});
      setNotice('已请求停止，等待执行端确认。');
      const next = await api<BusinessTask>(`/tasks/${pathId(task.id)}`); setTasks(old => mergeTasks(old, [next]));
    });
  }
  return { conversationId, status, conversation, messages, plans, tasks, turns, activities, before, drafts, selection,
    connection, notice, updatedConversations, sending, loadingHistory, pending: conversationId ? pending[conversationId] ?? null : null, actions, select, inspect, draft, older, create, send, present,
    confirm, stop, action, setNotice };
}
export type WorkspaceState = ReturnType<typeof useWorkspace>;

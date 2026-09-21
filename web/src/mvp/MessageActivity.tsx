import { useEffect, useState } from 'react';
import { api, failure, pathId } from './api';
import type { Turn, Activity } from './api';

// Resolve from the persisted source message, including turns older than the recent page.
export function MessageActivity({ conversationId, messageId }: { conversationId: string; messageId: string }) {
  const [open, setOpen] = useState(false);
  const [turn, setTurn] = useState<Turn | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!open) return;
    let cancelled = false; let timer: ReturnType<typeof setTimeout>;
    let after = 0;
    setActivities([]); setLoaded(false); setError('');
    async function read() {
      try {
        const source = await api<{ turn: Turn | null }>(`/conversations/${pathId(conversationId)}/messages/${pathId(messageId)}`);
        if (cancelled) return;
        setTurn(source.turn); setLoaded(true);
        if (!source.turn) return;
        let more = true; let latest = source.turn;
        while (more && !cancelled) {
          const page = await api<{ turn: Turn; activities: Activity[] }>(`/turns/${pathId(source.turn.id)}?after=${after}`);
          if (cancelled) return;
          latest = page.turn; setTurn(latest);
          setActivities(old => [...old, ...page.activities]);
          after = page.activities.at(-1)?.sequence ?? after;
          more = page.activities.length === 100;
        }
        setError('');
        if (!cancelled && latest.state === 'processing') timer = setTimeout(read, 900);
      } catch (e) { if (!cancelled) setError(failure(e)); }
    }
    void read(); return () => { cancelled = true; clearTimeout(timer); };
  }, [open, conversationId, messageId]);
  return <details className="m-small" onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>查看本轮活动</summary>
    {error && <p>{error}</p>}
    {!loaded && !error && <p>正在读取…</p>}
    {loaded && !turn && <p>此消息没有关联的模型轮次。</p>}
    {turn && <><p>轮次 {turn.generation} · {turn.state}{turn.reason ? ` · ${turn.reason}` : ''}</p>
      <ol>{activities.map(activity => <li key={activity.sequence}>#{activity.sequence} · {activity.kind}</li>)}</ol></>}
  </details>;
}

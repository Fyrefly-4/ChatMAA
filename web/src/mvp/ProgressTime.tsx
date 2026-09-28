import { useEffect, useState } from 'react';

export function ProgressTime({ since, label = '动作' }: { since?: number | null; label?: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const seconds = since == null ? null : Math.max(0, Math.floor(now / 1000 - since));
  return <p className="m-small">{seconds === null ? `${label}起始时间未记录` : `${label}已持续 ${seconds} 秒`}；仍在等待执行反馈，不代表已卡死。</p>;
}

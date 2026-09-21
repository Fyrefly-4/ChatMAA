import { StrictMode, lazy, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, errorText, hasToken } from './api';
const Legacy = lazy(() => import('./Legacy'));
const Workspace = lazy(() => import('./mvp/Workspace'));
function Entry() {
  const [mode, setMode] = useState<'mvp' | 'legacy' | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!hasToken) { setMode('legacy'); return; }
    let cancelled = false;
    api<{ entry?: string }>('/status').then(result => { if (!cancelled) setMode(result.entry === 'mvp-runtime' ? 'mvp' : 'legacy'); })
      .catch(e => { if (!cancelled) setError(errorText(e)); });
    return () => { cancelled = true; };
  }, []);
  return error ? <p role="alert">{error}<button onClick={() => location.reload()}>重新连接</button></p> : <Suspense fallback={<p>正在加载页面…</p>}>{mode === 'mvp' ? <Workspace /> : mode === 'legacy' ? <Legacy /> : <p>正在连接后台…</p>}</Suspense>;
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Entry />
  </StrictMode>,
);

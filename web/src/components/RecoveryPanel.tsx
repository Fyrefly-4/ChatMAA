import { useRef, useState } from "react";
import { api, errorText } from "../api";
import type { Status } from "../api";

export function RecoveryPanel({ status }: { status?: Status }) {
  const [confirmed, setConfirmed] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState("");
  const lock = useRef(false);
  const device = status?.device;
  const recovery = device?.recovery;
  if (!status) return null;
  if (!device) return <section className="warning" role="alert">设备状态暂不可读，暂缓发送新任务；已有任务仍可查询和停止。</section>;
  if (!device.blockers.length && recovery?.state !== "running") {
    return recovery?.state === "succeeded" ? <section className="warning" role="status">环境核对通过，可以发送新指令。历史任务结果保持原样；此前未受理的指令不会自动执行。</section> : null;
  }
  async function recover() {
    if (!device || !confirmed || lock.current) return;
    lock.current = true;
    setSending(true);
    setNotice("");
    try {
      await api("/takeovers", { id: crypto.randomUUID(), confirmed: true,
        targets: device.blockers.map(({ id, seq }) => ({ id, seq })) });
      setNotice("核对已受理，正在读取结果；不会开始刷取。");
    } catch (error) {
      setNotice(`核对未确认，请等待状态更新。${errorText(error)}`);
    } finally {
      setConfirmed(false);
      setSending(false);
      lock.current = false;
    }
  }
  return <section className="warning" aria-label="设备阻塞与人工接管">
    <h2>设备暂不能接受新任务</h2>
    {device.blockers.map(b => <p key={b.id}>
      {b.kind === "current" ? "当前执行待结束或确认停止" : "历史任务待人工接管"}：<code>{b.id}</code>。
      已确认 {b.confirmed} 次{b.certainty === "exact" ? "" : "（下限，未知部分保留）"}。
    </p>)}
    {recovery?.state === "running" ? <p role="status">正在核对环境，请等待；刷新页面不会重新执行。</p> :
      device.recoverable ? <>
        <h3>处理历史阻塞</h3>
        <p>请先接管游戏，确认没有其他自动化运行，并准备好支持的游戏界面。这里只做环境识别，不启动刷取，也不将旧任务改为完成。</p>
        <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />我已接管游戏，确认没有其他自动化运行，并已准备好界面</label>
        <button disabled={!confirmed || sending} onClick={() => void recover()}>核对环境并恢复使用</button>
      </> : <p>当前执行尚未安全结束，不能放行。请使用停止入口；若仍无法确认，请人工接管游戏并正常退出、重启应用后核对。</p>}
    {recovery?.state === "failed" && <p role="alert">{recovery.reason === "probe_stop_unconfirmed" ? "环境核对自身的停止尚未确认；本次启动不允许再次核对或提交任务。" : "未确认环境就绪，仍保持阻塞。请整理游戏界面，再明确发起核对。"}</p>}
    {recovery?.state === "interrupted" && <p role="alert">上次核对被中断，没有放行，也不会自动重试。</p>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}

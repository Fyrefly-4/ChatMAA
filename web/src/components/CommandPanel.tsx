import { useState } from "react";
import type { RequestView } from "../api";
export function CommandPanel({
  request,
  disabled,
  send,
}: {
  request?: RequestView;
  disabled: boolean;
  send: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  return (
    <section className="card">
      <span className="eyebrow">自然语言指令</span>
      <h2>这次要做什么？</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send(text);
        }}
      >
        <label htmlFor="command">完整指令</label>
        <textarea
          id="command"
          value={text}
          maxLength={8000}
          rows={3}
          placeholder="帮我刷 1-7 10 次，不吃药不碎石"
          onChange={(event) => setText(event.target.value)}
        />
        <div className="form-footer">
          <small>完整指令即本次授权；缺项时请重新给出完整指令。</small>
          <button disabled={disabled || !text.trim()}>发送指令</button>
        </div>
      </form>
      {request && (
        <div className="conversation" aria-live="polite">
          <p className="original">{request.record.original}</p>
          <p className="muted">助手回复描述调用时的状态；当前进度以执行事实卡为准。</p>
          <p>
            {request.record.reply ||
              (request.record.status === "running"
                ? "请求处理中，执行事实独立更新。"
                : "本轮模型请求已结束。")}
          </p>
          {request.record.error && (
            <p className="warning">
              模型或展示流程未完成（{request.record.error}
              ）；已有任务请以执行事实为准。
            </p>
          )}
          {request.record.status === "interrupted" && (
            <p className="warning">请求已中断，仅恢复读取，不会重新执行。</p>
          )}
        </div>
      )}
    </section>
  );
}

import type { RequestView } from "../api";
export function ToolDetails({ request }: { request?: RequestView }) {
  if (!request) return null;
  return (
    <details className="card tool-details">
      <summary>查看 Tool Call 与请求记录</summary>
      <p className="muted">这里是调用时的记录；当前结果以执行事实卡为准。</p>
      <p className="identifier">
        请求 {request.record.requestId}
        <br />
        操作 {request.record.operationId}
      </p>
      {request.events
        .filter((event) =>
          ["tool_call", "tool_result", "model_tools"].includes(event.kind),
        )
        .map((event, index) => (
          <div key={index}>
            <h3>{event.kind}</h3>
            <pre>{JSON.stringify(event.data, null, 2)}</pre>
          </div>
        ))}
      {!request.events.some((e) => e.kind === "tool_call") && (
        <p>尚无工具调用记录；模型文字不代表已执行。</p>
      )}
    </details>
  );
}

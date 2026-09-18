import { useExecution } from "./useExecution";
import { CommandPanel } from "./components/CommandPanel";
import { OperationSummary } from "./components/OperationSummary";
import { TaskCard } from "./components/TaskCard";
import { ToolDetails } from "./components/ToolDetails";
export default function App() {
  const state = useExecution();
  return (
    <main>
      <header>
        <div>
          <span className="eyebrow">CHATMAA / DEMO</span>
          <h1>
            把指令交给助手，
            <br />
            把过程看清楚。
          </h1>
        </div>
        <span className="mode">
          {state.status?.mode === "offline_callback_replay"
            ? "离线回放 · 不操作游戏"
            : state.status
              ? "真实执行环境"
              : "正在连接"}
        </span>
      </header>
      <p className="intro">
        当前支持 1-7 明确次数任务。一次一个任务，不排队、不自动补刷。
      </p>
      {state.connection && (
        <p className="warning" role="alert">
          {state.connection}
        </p>
      )}
      {state.status && !state.status.modelAvailable && (
        <p className="warning">模型尚未配置；已有任务仍可查询和停止。</p>
      )}
      {state.status?.closing && (
        <p className="warning">Backend 正在收尾退出。</p>
      )}
      {state.notice && (
        <p className="warning" role="status">
          {state.notice}
        </p>
      )}
      <div className="workspace">
        <div className="request-column">
          <CommandPanel
            request={state.request}
            send={state.send}
            disabled={
              state.sending ||
              !state.status?.modelAvailable ||
              state.status.closing ||
              !!state.status.busy ||
              state.request?.record.status === "running"
            }
          />
          {state.request?.record.summary && (
            <OperationSummary
              text={state.request.record.summary}
              requestId={state.request.record.requestId}
              receipt={state.request.pendingSummary}
              eligible={state.canAcknowledge}
              displayed={state.displayed}
            />
          )}
          <ToolDetails request={state.request} />
        </div>
        <TaskCard
          task={state.task}
          stop={state.stop}
          stopping={state.stopping}
          stopState={state.stopState}
          lastRead={state.lastRead}
        />
      </div>
      <footer>
        关闭或刷新网页不会停止已受理任务。状态不明时保留已知事实，交由人工核对。
      </footer>
    </main>
  );
}

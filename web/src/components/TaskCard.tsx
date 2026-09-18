import type { TaskView } from "../api";
import { taskPresentation } from "../task-presentation";
export function TaskCard({
  task,
  stop,
  stopping,
  stopState,
  lastRead,
}: {
  task?: TaskView;
  stop: () => Promise<void>;
  stopping: boolean;
  stopState: string;
  lastRead: string;
}) {
  if (!task)
    return (
      <section className="card task-card">
        <span className="eyebrow">执行事实</span>
        <h2>尚无已受理任务</h2>
        <p className="muted">
          输入完整指令后，先展示操作摘要。模型回复与任务执行分别更新。
        </p>
      </section>
    );
  const view = taskPresentation(task);
  return (
    <section className="card task-card" aria-label="当前任务">
      <div className="card-heading">
        <span className="eyebrow">执行事实 · 1-7</span>
        <span className="badge">{view.state}</span>
      </div>
      <h2>{view.count}</h2>
      <p>目标 {task.params.count} 次 · 不吃药 · 不碎石</p>
      <p>{view.remaining}</p>
      <p className={task.automation_stopped ? "positive" : "muted"}>
        {view.stopped}
      </p>
      <p className="muted">停止自动化不撤销消耗，也不保证游戏战斗立刻结束。</p>
      <button
        className="stop"
        onClick={() => void stop()}
        disabled={stopping || task.automation_stopped}
      >
        {" "}
        {stopping ? "正在请求停止…" : "停止当前任务"}{" "}
      </button>
      {stopState && <p role="status">{stopState}</p>}
      {!task.sync.available && (
        <p className="warning">
          Backend 暂时无法同步执行事实：{task.sync.reason ?? "原因未知"}
          。以下是最后已知结果。
        </p>
      )}
      {(task.gap || task.evidence_conflict) && (
        <p className="warning">
          执行证据存在{task.evidence_conflict ? "冲突" : "缺口"}
          ，未知部分需人工核对。
        </p>
      )}
      <dl>
        <dt>结束／当前原因</dt>
        <dd>{view.reason}</dd>
        <dt>环境</dt>
        <dd>{view.environment}</dd>
        <dt>执行证据来源</dt>
        <dd>
          {task.evidence_source === "offline_callback_replay"
            ? "离线回放（没有操作游戏）"
            : task.evidence_source}
        </dd>
        <dt>最近执行证据</dt>
        <dd>
          {task.updated_at
            ? new Date(task.updated_at * 1000).toLocaleString()
            : "暂无"}
        </dd>
        <dt>最近页面读取</dt>
        <dd>{lastRead || "正在读取"}</dd>
        <dt>任务 ID</dt>
        <dd className="identifier">{task.id}</dd>
      </dl>
    </section>
  );
}

# D5 Web 接入与检查

2026-09-21，从 D4 合并基线 `b9d580de` 建设，当前实现见本文件所在提交。页面已接入 Runtime、业务服务和正式 Python 回放；真实模型网页联调与真实游戏没有在本轮运行，不能据此宣称 D5 或 MVP 全部验收完成。产品与阶段标准分别见 [Spec #18](https://github.com/Fyrefly-4/ChatMAA/issues/18)、[D5 #24](https://github.com/Fyrefly-4/ChatMAA/issues/24)。

## 启动 MVP 页面

先按 [Backend](../../backend/README.md#准备与离线使用) 与 [CI 说明](ci-plan.md)准备依赖。在仓库根目录执行：

```powershell
npm --prefix web run build
New-Item -ItemType Directory -Force .artifacts/d5-review | Out-Null
@'
{"mode":"maa-replay","dataDir":"./data","port":0}
'@ | Set-Content -Encoding utf8 .artifacts/d5-review/config.json
$env:CHATMAA_CONFIG = (Resolve-Path .artifacts/d5-review/config.json).Path
npm --prefix backend start -- --runtime --web --no-model
```

打开终端 `web_ready.url`，页面读取 URL 片段中的本机令牌后移除片段。使用 `--no-model` 不加载 `.env`，可新建会话、读取历史、查询与停止已有任务，不能自然语言规划。该配置明确选择回放及独立数据目录，不使用 `backend/config.local.json`。首次空库不会自动产生方案或任务。

允许模型调用的检查可在明确授权后去掉 `--no-model`，配置沿用 [D4](d4-runtime.md)。模型凭据仅在 Backend，不放入 `VITE_` 变量。MuMu 配置沿用 [D2](d2-adapter.md)，只在明确的实机任务授权内使用；本轮没有改变根目录 `start-demo.ps1`，它仍是 legacy Demo 入口。

开发模式增加 `--web-dev`，并按 [Web](../../web/README.md)设置 Vite 的 `CHATMAA_BACKEND`。结束时在 Backend 终端 Ctrl+C，或使用 `npm --prefix backend run client -- shutdown`；等待 `shutdown` 的 `childExited`、`handoffComplete` 均为 true。关闭页面不停止任务。动态端口沿用原宿主行为，不新增端口管理机制。

## 模块与事实流

`web/src/main.tsx` 根据 `/api/status.entry` 分别加载 MVP `Workspace` 或 legacy `App`，样式也分别加载。模式和可用接口由服务器装配决定。MVP 使用同进程的 `RuntimeService`、`BusinessService`、`TaskService`，没有新增服务、库或执行协议。

| 入口 | 责任 |
|---|---|
| `backend/src/browser/mvp-routes.ts` | 浏览器字段白名单、固定按钮确认来源，调用既有服务 |
| `backend/src/browser/mvp-queries.ts` | 会话最小快照、消息与轮次双向分页、方案保存版本的依据、任务证据分页 |
| `web/src/mvp/useWorkspace.ts` | 全局与当前会话串行读取、ID 合并、每会话草稿、详情与待核对消息；切换后忽略旧响应 |
| `Workspace.tsx` | 会话导航、全局任务归属、连接层次、输入和历史滚动 |
| `PlanCard.tsx` | 完整方案、可见展示登记、修改／取消／独立确认，历史方案折叠 |
| `TaskSummary.tsx`、`presentation.ts` | 独立解释执行、过程、目标、可靠量、下界与未知 |
| `DetailPanel.tsx`、`MessageActivity.tsx` | 历史对象依据、原始执行事件与轮次活动；不解析聊天文本猜进度 |

消息带稳定 ID 提交给 Runtime，工具通过 Backend 创建方案；方案完整呈现且页面可见后登记展示。按钮确认引用展示 ID，自然语言确认仍作为新消息进入 Runtime。展示不代表授权，后台预取不登记展示。确认有效性、目标计算、互斥及防重由 Backend 判断；Python 执行后独立同步事实，模型失败不会阻断直接停止。

页面、Adapter 同步、业务投影、设备准入与模型状态分别显示。停止受理与自动化已停止分开，自动化已停止也不等于现场可用。模型和页面都不能将未知改成零，推算库存明确标注未重新扫描。所有成果来自业务投影或保存证据。

## 浏览器接口和恢复

所有 `/api` 继续检查 `x-web-token`、Host 与 Origin；`x-app-token` 不交给 Web。不暴露裸任务创建、任意角色写消息、通用业务转发、资料激活或关闭宿主。

| 接口 | 用途 |
|---|---|
| `GET /api/status` | 会话列表、全局任务、业务与执行环境、Runtime 可用性 |
| `POST /api/conversations`、`GET /api/conversations/:id` | 新会话和最小当前快照 |
| `GET /api/conversations/:id/messages?before=…&after=…` | 每次最多 20 条；before、after 二选一，游标必须属于该会话 |
| `GET /api/conversations/:id/messages/:message` | 核对原消息受理及其轮次，不重发 |
| `GET /api/conversations/:id/turns`、`GET /api/turns/:id?after=…` | 轮次与实际序号活动；终态仍读完所有页 |
| `POST /api/messages` | 用户消息立即受理，随后独立读取回复与任务 |
| `GET /api/plans/:id`、`POST …/present`、`POST …/confirm` | 保存的依据、稳定展示、独立按钮确认 |
| `POST /api/requests/:id/cancel` | 按版本取消当前请求 |
| `GET /api/tasks/:id`、`GET …/events?after=…`、`POST …/stop` | 独立任务事实、每页 100 条保存证据与直接停止 |
| `POST /api/tasks/:id/recheck`、`POST /api/takeovers` | 复用已有环境核对与明确人工接管 |

轮询采用请求完成后延迟约 650–900 ms，不保证实时延迟。同一路读取串行，切换时失效旧响应；停止有独立通路。证据游标使用实际序号，不假设连续。历史活动从消息 ID 定位，可读取最近 20 轮以外的记录。

刷新从 Backend 恢复业务历史，从 sessionStorage 恢复当前会话、草稿、所选详情及待核对 ID；不重发消息、确认或扫描。受理响应丢失时查询原消息／任务；查不到不宣称未执行。新启动令牌清理旧实例视图关联。同 ID 展示复用既有回执，重新实际呈现尚未展示的方案可以登记展示，但不会开始任务。

## 检查与证据范围

按 [CI 说明](ci-plan.md)执行现有检查。新增测试自动进入原单 Windows job，不引入真实模型调用：

- `backend/tests/mvp-browser.test.ts`：实际业务与内存 SQLite、执行通道替身，覆盖身份边界、字段限制、分页、来源版本、防重与存储失败时直接停止。
- `backend/tests/runtime-cli.test.ts`：实际无模型 `--runtime --web` 启动、浏览器身份与退出交接，显式回放配置。
- `web/tests/mvp.spec.ts`：真实页面、Runtime、BusinessService、TaskService、Python 回放与双库；只有模型响应使用 AI SDK 替身。核对任务实际操作数、刷新、消息／确认响应丢失、跨会话停止、模型失败、草稿与长历史。
- `web/tests/mvp-visual.spec.ts`：11 类受控 API 状态，1440／1024／736／390／320 px 布局、详情、边框、溢出及故障。截图在 `.artifacts/checks/d5-visual/`；这是展示证据，不是新增真实执行证据。

本轮不改 Backend 的目标核算、Runtime 意图契约或 Python 执行规则。替身短语只存在测试夹具，生产页面不识别“开始”等关键词来绕过 Runtime。真实模型网页连续使用、真实设备、软键盘及现场停止延迟仍需相应环境检查；D4 的真实模型 CLI 证据不替代 D5 网页证据。

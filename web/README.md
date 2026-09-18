# Web 执行台

一页 React + TypeScript 应用：输入完整指令、显示执行前摘要、独立读取任务事实、停止和查看工具调用。使用普通 CSS，无路由或全局状态库。浏览器只调用 Backend；模型、任务受理和执行记录仍由原模块管理。

## 启动与开发

先按 [Backend 准备说明](../backend/README.md#准备与离线使用)安装固定 Node、Python 和 Backend 依赖。仓库根目录执行：

```powershell
npm --prefix web ci
npm --prefix web run build
npm --prefix backend start -- --web
```

打开终端 `web_ready.url` 对应的本机地址。地址片段中的令牌只供本次本机启动；页面读取后立即移除地址片段，在当前标签页 `sessionStorage` 中保存。请勿分享该地址。API 同时检查令牌、Host 和 Origin，静态目录仅为 `web/dist`。

模型配置沿用 [Backend Agent 说明](../backend/README.md)的 `DEEPSEEK_API_KEY`；不得放入 `VITE_` 环境变量或前端文件。未配置模型也可查看、停止已有任务。默认无配置时为回放模式，**若存在 `backend/config.local.json` 会使用该配置**；离线检查务必明确使用 `maa-replay` 配置及独立数据目录，避免误用本地 live 配置。回放不操作游戏；真实模式必须按对应任务的明确授权运行。

开发时先启动 `--web --web-dev` Backend。另一个终端把实际 Backend 地址填入环境变量：

```powershell
$env:CHATMAA_BACKEND = 'http://127.0.0.1:实际端口'
npm --prefix web run dev
```

然后打开 Backend 打印的 `http://127.0.0.1:5173/#token=...`。Vite 固定监听该地址与端口，端口占用时失败，不自动换端口。代理只改变目标 Host，保留浏览器 Origin，也不注入 CLI 令牌。正式运行使用构建产物，不用开发服务器或 `vite preview`。

页面关闭或刷新不会停止已受理任务。退出应用使用 Backend 终端 Ctrl+C，或原 CLI `shutdown`；`--web` 不依赖标准输入存活。任务与请求留在原业务库，页面没有历史列表、解锁、重试或继续入口。

## 页面和状态从哪里修改

| 场景 | 入口 | 排查重点 |
|---|---|---|
| 修改布局／样式 | `src/App.tsx`、`src/style.css` | 请求区、摘要、任务卡和窄屏排列 |
| 修改输入／回复 | `components/CommandPanel.tsx` | 原文直接提交；不要在前端改写授权参数 |
| 摘要一直等待 | `components/OperationSummary.tsx` | 本次发送资格、可见页面、绘制机会及回执请求；刷新后的摘要只读 |
| 完成量／停止文案错误 | `task-presentation.ts`、`components/TaskCard.tsx` | `confirmed` 次数、`certainty`、`automation_stopped` 与同步状态各自含义 |
| 查询、停止或连接出错 | `api.ts`、`useExecution.ts` | Network 中的 `/api` 响应；请求 ID、任务 ID 与独立轮询，不把模型结束当任务结束 |
| 模型调用与任务事实不一致 | `components/ToolDetails.tsx` | 工具返回是当时快照，任务卡是后续事实；后端规则在 `agent/policy.ts`、`agent/tools.ts` 和 `task-service.ts` |

发送时生成稳定请求 ID；响应丢失后只读查询，不自动生成新 ID 重试。发送按钮忙碌不影响独立停止。失败的新任务不能替换原任务卡。轮询串行运行，约 500 ms 间隔；网络等待也会增加延迟，不是实时性能保证。停止期间的旧查询响应不覆盖新控制状态。

摘要自动回执只表示程序完成展示步骤，不代表用户已经阅读理解，也不是额外授权。只在本轮用户发送流程中产生回执；刷新只恢复 token 和当前请求／任务 ID，不自动恢复模型、补发指令或回执。新标签页可从状态接口发现冲突任务并停止，但不恢复完整聊天历史。

任务事实不从模型文字推导：可靠部分量可显示剩余次数；下界、证据缺口或冲突保留未知。页面断线与 Backend—Adapter 同步失败分别表达。稳定结束任务的旧证据时间不被当作断线；已停止也不等于设备已就绪。

## 离线验证

```powershell
npm --prefix web run check
npm --prefix web run build
node web/node_modules/playwright/cli.js install chromium
npm --prefix web run test:e2e
```

测试显式启动正式 Backend、SQLite 和 `maa-replay`，模型使用替身，不读取用户配置或调用真实模型；事实展示夹具另列。测试通过 IPC 请求收尾并核对 Python 退出，不依赖 Windows 信号式强杀证明交接。截图和失败 trace 位于忽略的 `.artifacts/checks/`。

本地已有 Edge 时可用 `$env:PLAYWRIGHT_CHANNEL='msedge'` 运行同一套检查；清除变量后恢复配套 Chromium。CI 固定使用配套 Chromium。浏览器离线回放、真实模型回放、真实游戏是不同证据；前者通过不代表后两者通过。

2026-09-19 本地验证：Backend 39 项、Adapter 25 项、浏览器 7 项、类型检查、构建及 actionlint 通过。本地浏览器为 Edge Chromium。另经实际页面发送一次完整指令到真实 DeepSeek，摘要先展示，唯一 submit_task 参数一致，正式回放确认十次完成，宿主及 Python 正常交接退出。模型回复说明受理时快照，独立任务卡随后显示最终结果。未运行真实游戏；首轮远端 Windows CI（`b4b4033`）通过；后续收尾修正需以最终提交的 CI 结果为准。

# ChatMAA

ChatMAA 是一个正在开发中的智能自动化应用，探索如何让 Agent 连接用户的自然语言目标与真实的自动化能力。项目以 MaaAssistantArknights（MAA）为执行环境，由 Agent 理解需求、选择工具，并结合执行反馈完成《明日方舟》相关游戏任务。

项目希望构建一个具备实际使用价值的 AI Native 应用，围绕自然语言交互构建完整的智能任务处理流程，涵盖用户意图理解、Agent 编排、工具调用、任务执行与结果反馈等核心能力，同时探索现代前端架构、全栈系统设计与 Agent Engineering 的工程实践。

已有 Demo 从明确的刷图指令切入，例如“帮我刷 1-7 十次”，打通自然语言到实际执行、进度展示、停止和结果查看的流程。新 MVP 计划将在此基础上建设连续对话与方案确认，支持补到指定库存、再获得指定材料数量和按次数刷图三种目标，并提供会话与任务历史。

## 开发进展

当前版本基于 [Demo #7](https://github.com/Fyrefly-4/ChatMAA/issues/7) 持续演进，已完成 AI Agent 从 Web 交互到本地自动化执行的完整链路验证。

现阶段系统已打通：

**Web Interface → Agent Runtime → TypeScript Backend → Local HTTP Service → Python Adapter → MaaCore**

并在 Windows 官方桌面端环境中完成了核心流程验证，包括任务执行、中途停止以及退出交接等场景。部分异常流程和不确定结果也已完成离线检查。

新 MVP 的产品设计与开发计划已完成规划，具体见：
- [Spec #18](https://github.com/Fyrefly-4/ChatMAA/issues/18)
- [路线 #19](https://github.com/Fyrefly-4/ChatMAA/issues/19)

后续开发将围绕新的 MVP 目标推进，重点完善 Agent 工作流、用户确认机制以及 Windows + 模拟器 环境下的稳定运行能力。

## 从这里开始

初次了解项目，可以先读[项目初衷与愿景](docs/overview/project-definition.md)，再读[当前工程与目标架构](docs/engineering/architecture.md)，了解各模块如何协作、代码在哪里，以及目前做到哪一步。

其他资料可按需要查阅：

| 内容 | 文档 |
|---|---|
| 产品功能与验收场景 | [MVP Spec #18](https://github.com/Fyrefly-4/ChatMAA/issues/18) |
| 开发路线与阶段进度 | [MVP 路线 #19](https://github.com/Fyrefly-4/ChatMAA/issues/19) |
| MVP 模块协作、状态与交互设计 | [协作约定与交互结构](docs/engineering/mvp-collaboration.md)（D1 文档交付，非实现或运行验收结论） |
| 项目术语 | [CONTEXT](CONTEXT.md) |
| 架构选择与取舍 | [运行结构](docs/adr/0001-runtime-structure.md)、[HTTP 通信](docs/adr/0002-local-http-adapter.md)、[记录归属](docs/adr/0003-execution-evidence.md)、[Agent Loop](docs/adr/0004-agent-loop-boundary.md) |
| CI 运行与新增检查接入 | [CI 使用与接入](docs/engineering/ci-plan.md) |
| 讨论过程与实验结果 | [历史与证据索引](docs/archive/README.md) |

## 运行与验证

以下入口运行现有 Demo。完成首次依赖准备后，在仓库根目录执行 `.\start-demo.ps1` 启动真实 Demo；`.\start-demo.ps1 -Replay` 使用回放执行端。完全离线运行使用 `.\start-demo.ps1 -Replay -NoModel`，同时使用回放执行端并禁用模型调用；单独的 `-NoModel` 仅禁用模型，不切换执行端模式。入口复用本地配置，真实模式查找当前窗口，打开网页，Ctrl+C 走现有退出交接。

完整网页演示从 [Demo 运行入口](docs/engineering/demo.md)开始：准备版本与依赖、显式选择回放或真实配置、打开网页、执行／停止及退出核对。当前精确基线为 Node 24.19.0、Python 3.12.14；固定 Windows 官方桌面端的真实网页到游戏链路已完成正常执行与中途停止验证；具体证据范围见[工程说明](docs/engineering/architecture.md#issue-11-真实整链验证2026-09-19)。

浏览器使用与前端排查见 [Web 执行台](web/README.md)。日常开发和独立操作从[正式 Backend 入口](backend/README.md)开始，默认离线，包含安装、提交、查询、停止及检查命令。[Adapter 说明](adapter/maa/README.md)解释真实接入、环境依据和记录边界。

原型继续保留为实验与历史证据：

- [本机执行链路与可控替身](prototypes/lifecycle/README.md)：了解后端与执行端的协作方式，通过替身检查任务控制和故障处理。
- [真实 MaaCore 原型](prototypes/maa/README.md)：了解实际接入环境、运行入口与执行证据。进行新的实机操作前，请按其中的交接要求确认环境和执行范围。

## 参与开发

可从上述文档了解项目。Agent 开展仓库工作前，请阅读 [AGENTS.md](AGENTS.md) 中的协作约定；更新说明或调整文档结构时，参考[文档维护规则](docs/agents/documentation.md)。

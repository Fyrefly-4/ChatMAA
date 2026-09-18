# ChatMAA

ChatMAA 是一个正在开发中的智能自动化应用，探索如何让 Agent 连接用户的自然语言目标与真实的自动化能力。项目以 MaaAssistantArknights（MAA）为执行环境，由 Agent 理解需求、选择工具，并结合执行反馈完成任务。

项目希望构建一个具备实际使用价值的 AI Native 应用，在完整的产品体验中实践和展示前端开发、全栈系统设计与 Agent Engineering 能力，贯通自然语言交互、任务理解、工具调用、实际执行和结果反馈。

首版从明确的刷图目标切入：例如，用户提出“帮我刷 1-7 十次”，Agent 理解关卡、次数和资源限制，通过工具调用交给 MAA 执行，应用展示进度并提供停止和结果查看入口。

## 开发进展

截至 2026-09-18，项目已打通 **TypeScript 后端 → 本机 HTTP → Python Adapter → MaaCore** 的执行链路原型，在指定的 Windows 官方桌面端环境中验证了小次数的 1-7 执行、进度回传、指定阶段的停止及结果交接。同时，项目通过可控替身和离线实验检查了部分故障处理行为。

Web 页面与 Agent Runtime 的接入仍待完成。完整应用的功能与验收要求记录在 [MVP Spec #1](https://github.com/Fyrefly-4/ChatMAA/issues/1)，已有实现及验证范围见[工程说明](docs/engineering/architecture.md)。

## 从这里开始

初次了解项目，可以先读[项目初衷与愿景](docs/overview/project-definition.md)，再读[当前工程与目标架构](docs/engineering/architecture.md)，了解各模块如何协作、代码在哪里，以及目前做到哪一步。

其他资料可按需要查阅：

| 内容 | 文档 |
|---|---|
| 产品功能与验收场景 | [MVP Spec #1](https://github.com/Fyrefly-4/ChatMAA/issues/1) |
| 项目术语 | [CONTEXT](CONTEXT.md) |
| 架构选择与取舍 | [运行结构](docs/adr/0001-runtime-structure.md)、[HTTP 通信](docs/adr/0002-local-http-adapter.md)、[记录归属](docs/adr/0003-execution-evidence.md)、[Agent Loop](docs/adr/0004-agent-loop-boundary.md) |
| 讨论过程与实验结果 | [历史与证据索引](docs/archive/README.md) |

## 运行与验证

当前可运行的内容集中在两个原型目录中，各自提供环境要求、运行步骤和实验报告：

- [本机执行链路与可控替身](prototypes/lifecycle/README.md)：了解后端与执行端的协作方式，通过替身检查任务控制和故障处理。
- [真实 MaaCore 原型](prototypes/maa/README.md)：了解实际接入环境、运行入口与执行证据。进行新的实机操作前，请按其中的交接要求确认环境和执行范围。

## 参与开发

可从上述文档了解项目。Agent 开展仓库工作前，请阅读 [AGENTS.md](AGENTS.md) 中的协作约定；更新说明或调整文档结构时，参考[文档维护规则](docs/agents/documentation.md)。

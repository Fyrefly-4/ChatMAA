# 仓库协作约定

## 项目背景

ChatMAA 将自然语言需求连接到 MAA 的游戏自动化能力。项目介绍见 [README](README.md)；当前实现、模块关系和代码落点见[工程说明](docs/engineering/architecture.md)。

## 文档语言

- 面向人的项目文档主要使用简体中文，用户或规格另有要求时遵循其要求。措辞自然易读，必要时解释陌生术语。
- 代码、标识符、API、配置名、协议名、官方名称和必要英文术语保留原文。
- 仅供 Agent 或机器使用的内容可采用适合其用途的语言和格式；混合文档中的人类可读说明仍遵循上述语言约定。

## 按任务查阅

按本次任务选择相关资料：

- 调查、制定计划或判断产品行为：从[信息归属表](docs/agents/documentation.md#信息归属)定位当前 Spec、路线和相关任务；涉及 GitHub Issue 的读取或维护时，遵循 [Issue 约定](docs/agents/issue-tracker.md)。
- 涉及领域术语、模块职责或架构取舍：遵循[领域文档约定](docs/agents/domain.md)，查阅相关术语、工程说明与 ADR。
- 修改代码：阅读涉及模块的说明（[Web](web/README.md)、[Backend](backend/README.md)、[Adapter](adapter/maa/README.md)）；准备环境、运行检查或修改 CI 时，查阅 [CI 使用与接入](docs/engineering/ci-plan.md)。
- 启动应用或验证运行行为：查阅 [Demo 运行说明](docs/engineering/demo.md)，选择与本次任务范围一致的回放、模型或实机运行方式。
- 创建、更新、迁移文档，或工程改动影响已有说明：遵循[文档维护规则](docs/agents/documentation.md)。

## Code Review Rules

- 所有审查反馈使用简体中文，包括总结、行内评论、问题标题、描述和修改建议；保留必要的技术术语、标识符、命令、路径和来源引文。
- 按被审变更对应的需求、适用规格和已接受的架构决定判断；区分本次范围内的缺陷与后续阶段尚未实现的能力。

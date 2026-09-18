# ChatMAA 项目初衷与愿景

定位：愿景与初始设想。原始入库版本：`ffd95a2`；状态标注核对于 2026-09-18。下文的 Phase、MVP、Demo 与 Roadmap 均保留早期语境，不作为当前阶段计划。当前实现见[工程说明](../engineering/architecture.md)。

> 本文描述项目愿景与初始设想，不代表当前已实现能力。首版范围、行为和验收条件以 [MVP Spec #1](https://github.com/Fyrefly-4/ChatMAA/issues/1) 为准。

ChatMAA 是一个基于 Agent 架构的智能自动化应用。

它通过大语言模型（LLM）理解用户自然语言目标，结合 Agent Runtime、Tool Calling 与任务执行反馈，将用户意图转换为可执行的自动化操作，并调用 MaaAssistantArknights（MAA）完成具体任务。

ChatMAA 的目标不是简单为 MAA 增加一个聊天入口，而是探索：

> 如何通过 Agent 作为智能层，将用户目标与确定性的自动化能力连接起来。

项目以 MAA 作为执行环境，构建一个完整的 AI Native 应用链路，包括用户交互、Agent 推理、工具调用、任务执行和结果反馈。

---

# 项目目标

ChatMAA 旨在构建一个具备实际使用价值的 Agent 自动化应用，并探索以下方向：

* 自然语言交互
* LLM 驱动的任务理解
* Tool Calling
* Agent Runtime
* 自动化任务执行
* 执行状态反馈
* AI Native 用户体验

项目重点关注：

* Agent 应用工程
* 全栈系统设计
* 自动化能力整合
* AI Native 产品交互设计

---

# 项目定位

ChatMAA 可以理解为：

> 一个基于真实自动化能力构建的 Agent 应用示例。

核心工作流程：

```
用户目标

↓

Agent 理解与规划

↓

调用确定性工具

↓

执行任务

↓

返回执行结果
```

与传统自动化工具相比，ChatMAA 希望降低用户对具体工具配置和操作流程的依赖，让用户更多关注最终目标。

传统模式：

```
用户

↓

学习工具规则

↓

配置参数

↓

执行任务
```

Agent 模式：

```
用户描述目标

↓

Agent 理解需求

↓

选择执行方式

↓

调用工具

↓

反馈结果
```

---

# 使用场景

## 当前目标用户

第一阶段主要面向 MaaAssistantArknights（MAA）用户。

原因：

* MAA 已具备成熟的自动化执行能力
* 部分任务存在较复杂的配置和操作流程
* 适合作为 Agent 与自动化结合的实践场景

---

## 核心场景

### 自然语言调用 MAA

用户：

> 帮我完成今天的日常任务。

Agent：

1. 理解用户需求
2. 判断需要调用的能力
3. 调用 MAA 执行任务
4. 返回执行状态和结果

---

### 任务辅助决策

用户：

> 我现在应该刷什么材料？

Agent：

1. 分析用户目标
2. 获取必要信息
3. 提供任务建议
4. 根据用户确认执行相关操作

---

# Agent 架构

ChatMAA 采用渐进式 Agent 设计，不追求一开始实现完全自主 Agent。

## Phase 1：智能助手

目标：

用户明确目标，Agent 负责理解请求并调用工具。

流程：

```
用户请求

↓

意图理解

↓

Tool Selection

↓

任务执行

↓

结果反馈
```

---

## Phase 2：任务规划助手

目标：

用户提供更高层目标，Agent 负责拆解任务。

流程：

```
用户目标

↓

任务分析

↓

生成执行计划

↓

用户确认

↓

执行任务
```

---

## Phase 3：自主 Agent

目标：

Agent 能够根据目标持续规划、执行，并根据执行反馈调整策略。

流程：

```
目标

↓

规划

↓

执行

↓

观察反馈

↓

调整策略
```

---

# 系统架构

ChatMAA 的核心组件是 Agent Runtime。

整体流程：

```
User Request

↓

Agent Runtime

↓

LLM Reasoning

↓

Tool Calling

↓

Execution

↓

Observation

↓

Response
```

---

## Agent Runtime

负责：

* 管理用户请求
* 维护上下文
* 调用 LLM
* 调度工具
* 管理任务执行流程

---

## Tool System

当前阶段：

MAA 是 ChatMAA 的主要执行工具。

未来可以扩展更多工具：

```
Agent Runtime

        |

      Tools

   /    |    \

 MAA   Web   File
```

当前阶段优先完成真实任务闭环，而不是构建通用 Agent 平台。

---

# 初始 MVP 设想

> 本节保留早期设想，正式 MVP 范围与验收要求以 [MVP Spec #1](https://github.com/Fyrefly-4/ChatMAA/issues/1) 为准。

## 目标

实现：

> 用户能够通过自然语言，让 Agent 调用 MAA 完成一个完整任务流程。

---

## MVP 功能

### 用户交互

* Chat 页面
* 消息展示
* Agent 状态展示
* 执行反馈展示

### Agent 能力

* LLM 调用
* Tool Calling
* 基础 Context 管理
* Agent Loop

### MAA 集成

* MAA Adapter
* 任务调用
* 执行结果获取

---

## 暂不包含

当前阶段不计划实现：

* 多 Agent 系统
* 长期 Memory
* 自研模型
* 复杂工作流编辑器
* 通用 Agent 平台
* 替代 MAA 本身

---

# Demo 展示

第一阶段 Demo 目标：

展示一个可以实际使用的 AI 自动化助手。

核心流程：

```
用户输入目标

↓

Agent 理解

↓

调用 MAA

↓

任务执行

↓

返回结果
```

同时提供开发者视角的信息：

* Agent 状态
* Tool Call 记录
* Execution Trace

---

# 项目范围

## 关注方向

* Agent 应用工程
* AI Native 产品设计
* 全栈系统实现
* 自动化能力整合

## 不关注方向

* 自研大模型
* AI 算法研究
* 游戏逻辑开发
* 通用 Agent 基础设施

---

# Roadmap

ChatMAA 希望逐步探索 Agent 应用开发的完整链路：

```
Frontend

+

Backend

+

Agent Runtime

+

Tool Ecosystem

+

AI Native Interaction
```

通过实际自动化场景，探索如何构建从用户目标到任务执行的完整 Agent 应用。

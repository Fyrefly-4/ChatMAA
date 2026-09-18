# 历史与证据索引

整理日期：2026-09-18。这里保存已经结束的讨论与原型阶段判断；当前结构、实现状态及未决事项统一查阅[工程说明](../engineering/architecture.md)。历史中的建议、授权和“下一步”属于当时语境。

## 2026 年 9 月原型阶段

| 材料 | 用途 |
|---|---|
| [架构讨论](2026-09-prototype/architecture-discussion.md) | Q1–Q12、选项、原始推荐与设计边界 |
| [审阅过程](2026-09-prototype/design-review-history.md) | R1–R5、原始验证计划及阶段推进记录 |
| [原型审阅总结](2026-09-prototype/prototype-review.md) | 本轮交付、验证范围、限制与当时的后续建议 |
| [替身报告](../../prototypes/lifecycle/REPORT.md) | 进程、HTTP、双库与故障实验，结合[证据摘要](../../prototypes/lifecycle/evidence/summary.json)阅读 |
| [MaaCore 实机报告](../../prototypes/maa/REPORT.md) | 导航失败、修复、一次加关联两次的成功记录 |
| [HTTP 合并报告](../../prototypes/maa/HTTP-MERGE.md) | 独立合并实验、停止、结果交接与未验证边界 |
| [环境记录](../../prototypes/maa/ENVIRONMENT.md) | 实际环境、参数、阶段授权与版本 |
| [合并离线摘要](../../prototypes/maa/evidence/http-merge-offline.json)、[合并实机摘要](../../prototypes/maa/evidence/http-merge-first.json) | 可追溯证据，保留失败、未知及现场确认来源 |

原始日志、截图和数据库仍位于原型的本地忽略目录，公开材料仅引用既有脱敏摘要。本次整理不修改证据内容。历史提交中的文档保留原路径；下面的对应表用于解释 Issue 或旧记录中的路径。

## 路径迁移表

| 整理前路径 | 当前位置 |
|---|---|
| `docs/ProjectDefinition.md` | [项目初衷与愿景](../overview/project-definition.md) |
| `docs/architecture.md` | [当前工程说明](../engineering/architecture.md) |
| `docs/design-review.md` | [原型审阅总结](2026-09-prototype/prototype-review.md) |
| `docs/architecture-history.md` | [架构讨论](2026-09-prototype/architecture-discussion.md) |
| `docs/design-review-history.md` | [审阅过程](2026-09-prototype/design-review-history.md) |

两份 history 文件来源于整理前已有的未跟踪快照；原型审阅总结来源于已有工作区修改。归档只补适用性说明和导航，保留正文的阶段判断。当前说明采用整理后的内容，历史材料不继续维护“最新状态”。

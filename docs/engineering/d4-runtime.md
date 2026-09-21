# D4 Runtime 实现与接入

2026-09-21，从 D3 合并基线 `818d123` 开始建设。**当前为开发中，不代表 D4 完成。** 产品行为依据 [Spec #18](https://github.com/Fyrefly-4/ChatMAA/issues/18)，阶段条件见 [D4 #23](https://github.com/Fyrefly-4/ChatMAA/issues/23)。

## 已实现的基础

`backend/src/runtime/` 与既有 `agent/` 分开，后者保持 legacy Demo 语义。Runtime 仍与业务服务同进程，记录进入原 TS SQLite，不改变 Python 执行证据归属。

- `records.ts`：用户消息与轮次原子受理；同消息 ID 重传只读取原轮次，内容冲突拒绝。新消息更新会话代次并中断旧轮；最终助手消息和轮次完成同事务保存。活动按序号分页，启动恢复只标记未完成轮次中断。
- `context.ts`：选取近期消息、当前请求来源与当前用户消息，附加 Backend 的方案、展示和任务事实。旧业务 `system` 消息保持数据角色；预算不足时先移除可选历史，必要来源仍超限则明确失败。
- `service.ts`：同会话替换、取消与发布检查；模型总时限最多 60 秒，默认并发上限 4。取消和超时不等于游戏停止。忽略取消的模型仍计入并发容量，晚到回复不能写入记录；容量满时明确记录忙碌，不排队执行。
- `business/records.ts`：会话范围内消息分页、文字过滤与当前方案最近展示查询；跨会话游标拒绝。

当前 `RuntimeService` 接收注入的轮次函数，供离线检查；还没有正式 AI SDK 工具循环、业务工具、后台 consumer 或 HTTP／CLI 装配。不能使用这些基础文件宣称自然语言已能执行 MVP 业务。

## 当前验证范围

Node 24.19.0 下，Backend 类型检查、Runtime 9 项检查和 D3 业务 29 项回归通过。检查使用实际 `BusinessService` 与内存 SQLite、受控模型函数；执行通道替身拒绝任何执行调用。覆盖原子回滚、会话隔离、消息防重、过期输出、忽略取消、超时、关闭、容量和只读恢复。

没有本轮真实模型、正式 Adapter 回放或游戏证据。阶段仍需业务工具、多步反馈、异步后续、正式回放链路与真实模型样例，完成条件保持不变。

检查入口：

```powershell
npm --prefix backend run check
node --test --test-concurrency=1 backend/tests/business.test.ts backend/tests/runtime-records.test.ts
```

完整检查及环境准备见 [CI 说明](ci-plan.md)，业务操作及确认语义见 [D3 契约](d3-backend.md)。

# D4 Runtime 实现与接入

2026-09-21，从 D3 合并基线 `818d123` 开始建设。**当前为开发中，不代表 D4 完成。** 产品行为依据 [Spec #18](https://github.com/Fyrefly-4/ChatMAA/issues/18)，阶段条件见 [D4 #23](https://github.com/Fyrefly-4/ChatMAA/issues/23)。

## 已实现的基础

`backend/src/runtime/` 与既有 `agent/` 分开，后者保持 legacy Demo 语义。Runtime 仍与业务服务同进程，记录进入原 TS SQLite，不改变 Python 执行证据归属。

- `records.ts`：用户消息与轮次原子受理；同消息 ID 重传只读取原轮次，内容冲突拒绝。新消息更新会话代次并中断旧轮；最终助手消息和轮次完成同事务保存。活动按序号分页，启动恢复只标记未完成轮次中断。
- `context.ts`：选取近期消息、当前请求来源与当前用户消息，附加 Backend 的方案、展示和任务事实。旧业务 `system` 消息保持数据角色；预算不足时先移除可选历史，必要来源仍超限则明确失败。
- 被新消息替代或失败的轮次，其来源保留在 `pendingSources`，直到后续轮完成；对应业务操作一同进入上下文。承接旧意图时工具使用其中的 `intentMessageId`，宿主核对消息角色与会话并复用原操作 ID；确认只允许当前消息，独立新意图使用新的来源。
- `service.ts`：同会话替换、取消与发布检查；模型总时限最多 60 秒，默认并发上限 4。取消和超时不等于游戏停止。忽略取消的模型仍计入并发容量，晚到回复不能写入记录；容量满时明确记录忙碌，不排队执行。
- `operations.ts`：按来源消息、操作、对象版本和规范化参数建立稳定关联。同步业务变更与关联共用事务；确认、扫描和调整在原业务事务中调用同步关联接口，HTTP 仍在事务外。响应或结果保存失败保留原目标与未知状态，读取记录不会重新发送。
- `business/records.ts`：会话范围内消息分页、文字过滤与当前方案最近展示查询；跨会话游标拒绝。

`loop.ts` 已接入 AI SDK 有界循环，最多 8 步、12 次工具调用、无自动重试，最后一步关闭工具。`instructions.ts` 集中保存行为规则及版本；`tools.ts` 提供业务白名单并绑定会话、来源消息、对象范围。模型没有展示回执、按钮身份、原始执行参数或任意 HTTP 工具；同一步只允许一次业务变更，后续步骤根据新事实继续。

`RuntimeService` 当前接受注入的轮次函数，`modelRunner` 可连接 AI SDK 模型；调用 `enableFollowups()` 可接收 Backend 后续事件。后台等待当前用户轮结束，再读取最新事实并使用只读工具；发布通过 `acceptFollowup` 同步检查请求版本和一次性 token，消息及完成记录同事务保存。新用户消息同时中断等待或采样并撤销 token，迟到输出不能发布。正式 HTTP／回放 CLI 与 --runtime 启动入口已装配。已受理业务操作独立追踪，关闭 Runtime 时等待这些有界操作结束，模型本身忽略取消时不能阻止退出。

后台事件检查目前覆盖人工注入的 D3 continuation 边界，不替代正式扫描完成触发的整链验证。`explain_waiting` 关联具体事件、请求版本与等待原因，说明由宿主追加到最终回复，消息与解释标记同事务保存；等待中的消费者只在该标记存在时跳过重复采样。任意助手回复不表示该事件已处理，解释完成也不表示业务等待已解决。

## 当前验证范围

正式 `maa-replay` 集成检查已通过次数、材料增量和补库存三种目标。次数路径经过真实本机 HTTP，三种目标均接实际 Backend、Python Adapter 与两库；补库存先扫描，材料增量不扫描，均在展示确认后执行。独立进程 --runtime --no-model 与 CLI 的消息、完整方案输出、展示防重、确定确认和退出交接已验证。模型使用 AI SDK 替身，集成测试展示为显式模拟回执，CLI 另验证实际输出；不代表真实模型或网页证据。

Node 24.19.0 下，Backend 类型检查、Runtime 32 项检查和 D3 业务 29 项回归通过。检查使用实际 `BusinessService` 与内存 SQLite、受控模型函数及 AI SDK MockLanguageModelV4；轮次检查不执行任务，操作关联检查使用内存执行通道替身。覆盖原子回滚、会话隔离、消息防重、过期输出、忽略取消、超时、关闭、容量和只读恢复，以及提交前关联故障、提交后结果保存故障和调整停止意图回滚。SDK 检查根据真实资料工具的匹配结果分支决定建草案或澄清，另检查并行变更、确认消息顺序、跨会话限制与循环上限；这不证明真实模型自然语言理解质量。

没有本轮真实模型或游戏证据。阶段仍需异常路径补充、最终全量检查、逐项完成审计及真实模型样例；完成条件保持不变。

检查入口：

```powershell
npm --prefix backend run check
node --test --test-concurrency=1 backend/tests/business.test.ts backend/tests/runtime-records.test.ts backend/tests/runtime-operations.test.ts backend/tests/runtime-loop.test.ts backend/tests/runtime-followups.test.ts backend/tests/runtime-integration.test.ts backend/tests/runtime-cli.test.ts
```

完整检查及环境准备见 [CI 说明](ci-plan.md)，业务操作及确认语义见 [D3 契约](d3-backend.md)。

## 调试入口

先按 [Demo 回放配置](demo.md#回放入口)显式设置 `CHATMAA_CONFIG`，避免读到本地 live 配置。`node backend/src/main.ts --runtime --no-model` 可检查连接及确定操作，不加载模型密钥；显式去掉 `--no-model` 才按现有 DeepSeek 配置启用模型。启用模型不等于获得本轮真实模型调用授权。

`--runtime` 不能与 engineering 或 legacy 模式混用；默认 MVP 无模型入口保持可用。关闭时先撤销 Runtime 写入资格并取消后台消费者，再排空操作、交接执行证据。

应用令牌保护的接口：`GET /runtime/status`、`POST /runtime/messages`（`conversationId`、稳定 `messageId`、`text`）、`GET /runtime/turns/:id?after=序号`、`GET /runtime/conversations/:id`。展示、按钮确认、查询与停止继续使用 D3 确定操作。当前接口拒绝浏览器 Origin，D5 需在浏览器身份边界内包装同进程服务，不能将应用令牌交给网页。

回放客户端 `node backend/src/runtime/cli.ts` 支持：

```powershell
node backend/src/runtime/cli.ts new chat 测试会话
node backend/src/runtime/cli.ts message chat message-1 '刷1-7一次'
node backend/src/runtime/cli.ts watch <返回的轮次ID>
node backend/src/runtime/cli.ts show chat
node backend/src/runtime/cli.ts message chat message-2 '按这个开始'
node backend/src/runtime/cli.ts state chat
node backend/src/runtime/cli.ts stop <任务ID>
```

模型消息示例须在模型调用获准后执行；无模型时消息记录以 `model_unavailable` 结束。`show` 完整打印结构化方案后登记 `cli-方案ID` 展示回执，重试复用回执；`state` 只读取。也可用 `confirm <方案ID> <展示ID> <确认ID>` 确定确认。客户端拒绝 live 配置和非 `mvp-runtime` 连接，退出客户端不关闭宿主；关闭仍用原 `node backend/src/cli.ts shutdown`。

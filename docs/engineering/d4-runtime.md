# D4 Runtime 实现与接入

2026-09-21，代码核对至 `a46e20d`，从 D3 合并基线 `818d123` 建设。实现与分层验证进入阶段审阅；不代表完整页面或真实游戏整体验收。产品行为依据 [Spec #18](https://github.com/Fyrefly-4/ChatMAA/issues/18)，阶段条件见 [D4 #23](https://github.com/Fyrefly-4/ChatMAA/issues/23)。

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

后台事件既有 D3 continuation 边界注入，也已通过正式扫描缺失材料触发的整链检查。`explain_waiting` 关联具体事件、请求版本与等待原因，说明由宿主追加到最终回复，消息与解释标记同事务保存；等待中的消费者只在该标记存在时跳过重复采样。任意助手回复不表示该事件已处理，解释完成也不表示业务等待已解决。

2026-09-21 PR #31 审查修正：新用户消息的受理事务同时将本会话已有 pending／processing 延续标为 interrupted 并清除 token，提交后再中断内存消费者，覆盖已领取但尚未注册的窗口。消息重传不重复失效，受理回滚不提前取消旧消费者；用户轮开始后新到达的事件仍可等待该轮结束再处理。新增四项调度与事务回归通过。

## 当前验证范围

正式 `maa-replay` 集成检查已通过次数、材料增量和补库存三种目标。次数路径经过真实本机 HTTP，三种目标均接实际 Backend、Python Adapter 与两库；补库存先扫描，材料增量不扫描，均在展示确认后执行。独立进程 --runtime --no-model 与 CLI 的消息、完整方案输出、展示防重、确定确认和退出交接已验证。模型使用 AI SDK 替身，集成测试展示为显式模拟回执，CLI 另验证实际输出；不代表真实模型或网页证据。

Node 24.19.0 下，Backend 全量 136 项通过；后续提示与工具描述调整后的类型检查和 Runtime 39 项通过。Adapter 59 项、Web 类型检查／构建、Edge 浏览器 18 项在本阶段通过，之后未修改 Adapter／Web。检查使用实际 `BusinessService` 与内存 SQLite、受控模型函数及 AI SDK MockLanguageModelV4；轮次检查不执行任务，操作关联检查使用内存执行通道替身。覆盖原子回滚、会话隔离、消息防重、过期输出、忽略取消、超时、关闭、容量和只读恢复，以及提交前关联故障、提交后结果保存故障和调整停止意图回滚。SDK 检查根据真实资料工具的匹配结果分支决定建草案或澄清；另检查确认顺序、跨会话限制、循环上限，以及截断、空白和误输出工具协议时拒绝发布。这些离线检查不替代真实模型样例。

本阶段已调用 DeepSeek `deepseek-flash`，连接实际 Backend 与正式 `maa-replay`。回放来源是 `synthetic_d2_callbacks`，不是新 MuMu 或真实游戏证据。模型样例保存原始输入、工具、业务对象与回复，人工核对范围如下：

| 样例 | 已核对的行为 |
|---|---|
| 次数、材料新增、补库存 | 补充承接、72 补到 75 得到差额 3；三类经展示后确认执行 |
| 咨询、修改与改写 | 咨询不变更；“修改并直接开始”仍等新确认；再次执行产生新需求 |
| 未知／已满足库存 | 缺失不是零；72 已满足 70，不生成刷图任务 |
| 缺推荐／不适用关卡 | 缺推荐夹具要求补关卡；不适用的用户指定不被擅自替换 |
| 执行中调整与停止 | total／additional 保留不同语义；假设不停止，含糊调整先请求停止；无自动替代执行 |
| 下界与中断 | 不给出精确剩余；新消息中断旧模型，停止经实际 Backend 下发 |
| 后台澄清 | 实际扫描缺材料触发只读模型与一次性发布，不自动重扫或执行 |
| 异常资料与超时 | 资料字段中的指令未产生业务变更；1 秒人为时限触发模型中断，不自动重试 |

首轮不是全部通过：曾误用独立查库存替换补库存目标，2000 输出 token 被推理用尽，以及关闭工具后将 DSML 当正文。修正工具与提示说明、增加明确收尾指令，输出上限调为 6000（仍含推理），截断／空白／DSML 正文记失败；针对失败路径复验。随后修正默认候选被误记作用户指定、运行状态被说成已开战的问题。失败证据与各提示版本保留在本地 `.artifacts/d4-model-validation/`，没有自动重试直到成功。代表样例不构成任意表达均可靠的保证；回复仍可能冗长或重复澄清，确定方案、进度及停止入口仍以业务事实为准。

检查入口：

```powershell
npm --prefix backend run check
node --test --test-concurrency=1 backend/tests/business.test.ts backend/tests/runtime-records.test.ts backend/tests/runtime-operations.test.ts backend/tests/runtime-loop.test.ts backend/tests/runtime-followups.test.ts backend/tests/runtime-integration.test.ts backend/tests/runtime-cli.test.ts
```

完整检查及环境准备见 [CI 说明](ci-plan.md)，业务操作及确认语义见 [D3 契约](d3-backend.md)。

## 调试入口

真实模型样例驱动为 `node backend/src/runtime/samples.ts --allow-model`；边界与后台样例用 `node backend/src/runtime/edge-samples.ts --allow-model`。必须先获得该次调用授权，并用 `CHATMAA_CONFIG` 显式指定 `mode=maa-replay` 的配置。两入口在读取模型凭据和启动宿主前拒绝 live，不进入离线 CI。用 `--scenario inventory,material` 等名称列表定向验证，省略则运行该入口全部样例。

驱动保存模型标识、提示版本、输入、工具活动、业务快照与退出结果到本地数据目录下的 `model-samples-*/evidence.json` 或 `model-edges-*/evidence.json`。普通样例实际打印方案后才登记展示；边界样例中的长任务由脚本模拟前置展示／按钮确认，缺推荐及指令性资料是明确标注的夹具。它们验证模型读取与后续选择，不作为用户前置交互的证据。边界驱动每场景独立宿主，检查结束后的清理停止单独记录；超时样例人为设为 1 秒，正式运行仍为 60 秒。脚本退出不等于验收通过，需核对原文、工具参数、当时事实、最终事实及回复。

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

正式回放另覆盖执行中不可比较目标的调整：工具先请求停止，再由 Backend 拒绝错误的总目标，原任务不恢复且不建立替代执行。外层操作关联事务回滚时，后台事件不会提前领取或启动；派发推迟到事务结束后。

## D5 同进程契约与活动

类型入口为 [contract.ts](../../backend/src/runtime/contract.ts)，咨询轮次的展示夹具见 [runtime-consultation.json](fixtures/runtime-consultation.json)。夹具为结构样例，时间、标识和内容均为示例，不是实际模型证据。D5 可复用这些服务及类型；页面与浏览器身份包装仍须独立实施验证。

`submit(conversationId, messageId, text)` 同步返回轮次，模型处理在后台继续；同 ID 同内容返回原轮次。`read(turnId, after)` 返回当前轮次和最多 100 条后续活动，序号在库中全局递增，按本轮最后序号续读，允许有间隔。`conversation(id)` 返回 D3 会话事实、最近 20 个轮次和当前方案展示；最终回复按 `message` 活动的 messageId 从业务消息读取。页面刷新仅恢复读取，不能重新生成消息 ID 或重新执行。

| 活动／字段 | 页面含义 |
|---|---|
| accepted / followup_accepted | 用户消息／后台事件已建立轮次，不表示游戏已受理 |
| model_started / model_step | 模型配置、提示版本、步骤结束与用量；不包含隐藏推理 |
| tool_call / tool_result | 工具与 call ID、输入、操作关联或拒绝原因；业务事实仍以最新查询为准 |
| message | 完整助手消息已持久发布，读取对应消息正文 |
| completed / failed / interrupted | 助手轮次结束；游戏任务独立，不据此判断已停止或成功 |
| sourceMessages / continuationId | 本轮承接的用户消息或后台事件，用于关联展示，不代表新增授权 |

`model_unavailable`、`model_busy`、`model_timeout` 是轮次失败／中断原因，确定查询和停止仍可用；`context_budget_exceeded` 要求缩小问题，不截断必要约束。`model_output_budget_exceeded`、`model_empty_response`、`model_invalid_response` 表示回复截断、空白或误输出工具协议；不发布残缺正文、不自动重试，已提交业务操作不会撤销。对象范围、版本和确认拒绝以工具 error 呈现；`committed` 或 `unknown` 操作应查 targetId，不换 ID 重发。工具记录故障关闭本轮，不以聊天回复覆盖任务结果。

页面展示完整方案后调用 D3 `present`，复用稳定展示 ID；按钮确认调用 D3 `confirm(..., 'button')`，自然语言确认经过 Runtime 且必须是展示后的新消息。直接停止调用 D3 `stop`，不等待模型。应用令牌 HTTP 只是调试面，D5 包装前须保留浏览器 Host／Origin 与独立令牌检查。

模型循环目前为 8 步、12 次工具、每步输出最多 6000 tokens（含推理）、总时限 60 秒，输入按约 48000 字符限制。扫描／执行／停止受理后，宿主关闭后续工具并明确要求自然语言收尾；明确调整直接调用会先停止的 adjust_task，含糊调整则先 stop_task 收尾并澄清。当前提示版本为 `d4-5`。

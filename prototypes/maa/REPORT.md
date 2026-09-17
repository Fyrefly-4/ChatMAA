# 真实 MAA 原型实验记录

跟踪：[Issue #4](https://github.com/Fyrefly-4/ChatMAA/issues/4)。本报告记录实测结果，不代表 MVP 验收完成。

**本轮结论：累计 3/3 成功，用户现场确认一致。** 首局成功后由初版解析器提前停止；修复后用关联新任务连续完成剩余两局，并确认正常停止、实例销毁及进程退出。两个实际接入问题已修复：宿主 DPI 初始化与可选次数字段解释。原型 A 的基本实机链路已走通；异常场景及与原型 B 的 HTTP 合并验证仍未完成。

后续 HTTP 合并准备已完成 11 项离线检查、原替身回归及交接驱动演练，发现并修复停止意图被迟到轮询覆盖、正常退出时最终证据未同步的缺口。回归中也保留了两次读库 I/O 异常及实验清理修复的记录。没有增加实机成功次数；完整结果、模块与待确认实机方案见 [HTTP-MERGE.md](HTTP-MERGE.md)。

## 环境与范围

- Windows 官方桌面端，官服，已有 `1-7` 代理；Python `3.12.14`，MaaCore API 版本 `v6.17.5`。
- 本轮要求三次单局代理：`times=3`、`series=1`；`medicine=0`、`medicine_expire_days=0`、`stone=0`，不自动重启游戏，不上报掉落。
- 使用原生窗口接口：`PrintWindow` / `SendMessageWithWindowPos` / `SendMessage`。普通权限截图返回 Windows 错误 5；用户在管理员 PowerShell 启动后，绑定与 `1280×720` 截图成功。
- 原始路径、窗口标识、截图及完整日志留在被忽略的 `.artifacts/`。仓库仅保留脱敏摘要与代码。

## 首轮：导航失败，停止收尾完成

2026-09-17 23:45:40–23:45:51（Asia/Shanghai），入口 `run-first-three-admin.ps1`。脱敏证据：[first-three.json](evidence/first-three.json)。

| 相对时间（从 Core 加载完成计） | 证据 | 可支持的解释 |
|---|---|---|
| 0.172 s | `AsstStart` 返回成功、`TaskChainStart` | 执行被接受，不能视为已开战 |
| 1.032–1.172 s | `ReturnButton` 开始/完成；native 日志记录一次点击 | 从终端页面返回主界面，输入至少在这个按钮上生效 |
| 9.860 s | `SubTaskError`，`ProcessTask` 起点 `StageBegin` | 关卡导航未完成 |
| 9.875 s | `TaskChainError`，随后 `AllTasksCompleted` | 原生“全部任务结束”仍可伴随失败，不能直接映射业务成功 |
| 9.922 s | 原型请求停止，`AsstStop` 返回成功 | 停止请求已被处理，但仍需核对运行状态 |
| 10.422 s | `AsstRunning=false` | 已观察到自动化不再运行 |
| 10.860 s | `AsstDestroy` 返回 | 本实例收尾完成；随后确认执行进程不存在 |

本轮已确认完成量为 **0**。回调中没有开战与掉落结算记录；完整 native 日志只记录一次返回点击，结束截图为主界面。证据支持失败发生在开战前，不将导航失败计为战斗失败，也没有自动补刷。用户现场核对仍单独保留，不由脚本伪造为已确认。

日志显示：回到主界面后，`Fight` 与主题切换入口 `Fight@SwitchTheme@ToggleSettingsMenu` 均未识别成功。结合本地资源的识别区域与截图，当前怀疑界面主题兼容性，**尚未证明根因**；不能据此断言官方桌面端整体不受支持。MAA 官方也说明未适配主题可能影响主界面识别，见 [Switch Theme](https://docs.maa.plus/en-us/manual/introduction/switch-theme.html)。

首轮暴露了原型报告层的一个问题：旧入口退出码 `0` 只表示 Python 无异常，并未表达任务失败；实际 `result.json` 已记录失败。后续改为 `0`＝计数证据匹配（仍待现场核对），`1`＝运行/记录异常，`2`＝目标未完成，同时在错误摘要保留子任务与导航上下文。原始首轮记录不回写。

## 第二轮：更换界面主题后仍在导航阶段失败

用户核对后明确授权「可以再进行一次」。保持三次目标与资源限制，由用户切换界面主题并回到主界面，再启动 `run-second-three-admin.ps1`。2026-09-17 23:48:56–23:49:03，第二轮仍在 `StageBegin` 导航阶段收到 `SubTaskError`。没有开战、掉落结算或控制器点击记录，已确认完成量仍为 **0**；随后观察到 `TaskChainStopped`、`AsstRunning=false` 和实例销毁返回，执行进程已退出。脱敏证据见 [second-three.json](evidence/second-three.json)。

截图确认主题外观已变化，但仍无法完成识别。因此，“切换日间主题即可解决”未成立，根因继续保留待查，不能直接归因给 MAA 或原型任一方。两轮各自保留原始记录，没有重放。

用户当时决定先配置 MAA 和游戏，确认官方 MAA GUI 在本机可独立运行，实验随之暂停。交接时需要记录实际 MAA/Core 与资源版本、连接/截图/输入设置、界面主题及受限执行结果，再比较原型与 GUI 的差异；后续恢复过程如下。

## 配置修复后恢复实验

用户随后明确告知「已修复配置成功，请继续」。读取安装目录 GUI 日志可见其已成功匹配主界面入口，导航至公开招募并实际操作；连接方法仍为上述三项，Core 文件和资源版本未变化。这确认了部分识别/输入链路可用，但不等于 `1-7` 已验证。现准备独立第三轮入口，保持三次目标与相同资源限制，等待实测结果。

第三轮仍在导航阶段失败，已确认完成量为 0；停止与销毁有独立记录，见 [third-three.json](evidence/third-three.json)。用户指出应提高测试效率，因而停止重复实机试跑，改为先对照 GUI 初始化与失败截图。

## DPI 差异与诊断流程改进

2026-09-18 对照得到以下证据：

- 固定版本官方 [GUI manifest](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/v6.17.5/src/MaaWpfGui/app.manifest) 声明 `system` DPI awareness；原型 Python 进程实测 awareness 为 `0`（不感知 DPI），设置为 system 后为 `1`，系统 DPI 为 `120`，即 125% 缩放。
- 第三轮失败时的原始截图出现放大、裁切，而停止后截图恢复正常。离线按原识别区域比对同一模板：失败截图分数约 `0.283`，缩小至 80% 后约 `0.979`；停止后截图未经缩放约 `0.968`。见 [dpi-diagnosis.json](evidence/dpi-diagnosis.json)。这是独立的模板相关度计算，不冒充完整 MaaCore 实机识别结果。
- 官方 [ProcessTask](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/v6.17.5/src/MaaCore/Task/ProcessTask.cpp) 在主界面识别前切换截图模式；[Win32Controller](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/v6.17.5/src/MaaCore/Controller/Win32Controller.cpp) 会按窗口位置输入模式调整窗口/鼠标位置。因此，只检查绑定后的静态截图不足以覆盖真实识别路径。

已修复原型：在创建 Core 线程前设置与 GUI 一致的 system DPI awareness，并记录实际 DPI；另补载 GUI 日志中存在的 `cache/resource` 热更新层。检查到该缓存主要含活动资源，不能将补载缓存单独认定为导航问题的根因。

测试改为单一入口 `verify-and-run-admin.ps1`：先运行原生 `Custom` 识别探针，保留 `Fight` 主界面识别路径，但覆盖为 `action=Stop`、清空所有导航子任务和后继，不点击按钮或进入战斗；只有实际匹配及探针正常收尾通过，才以独立进程进入三次任务。两阶段日志自动保存，失败停在对应阶段，避免反复让用户复制日志或直接重刷。此时 6 项离线测试、两类任务参数加载通过；修复后的实机结果仍待该入口验证。

## 修复后首局与计数回归

统一入口的原生主界面识别已实际通过，匹配分数 `0.987229`，随后成功导航并执行一局 `1-7`。结算截图显示三星，与同一任务 `StageDrops` 的关卡和星级一致，用户现场反馈「成功」。

初版解析器却把可选 `cur_times` 缺失判为计数未知，并在首局后停止。固定版本 [StageDropsTaskPlugin](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/v6.17.5/src/MaaCore/Task/Fight/StageDropsTaskPlugin.cpp) 仅在识别到次数时附带该字段，缺字段不能直接视为没有成功。

解析修复后，同一任务内组合以下证据：`FightTimes.series=1` 的实际倍率、`StartButton2` 点击完成、`EndOfAction` 结算识别、`StageDrops` 的 `1-7` 三星。按开战序号关联并去重；缺少任何关键证据、倍率或显式次数冲突时仍保留未知，不能仅凭 `times_finished` 累加成功。

用完整真实回调重算后确认成功 **1 次**，旧执行已经停止并销毁。原始 `result.json` 保留，另存 `result-reinterpreted.json`，解释版本为 `2`。提交的脱敏依据见 [verified-first-battle.json](evidence/verified-first-battle.json) 与 [verified-first-result.json](evidence/verified-first-result.json)。9 项检查通过，覆盖真实缺字段回放、整段重复回放不重复计数、缺失/冲突证据和三个独立周期计数。

随后建立关联新执行 `remaining-two`（`continues=verified-three`），目标为剩余 **2 次**，继续原资源限制；未从头重刷三次。00:11:51 开始、00:14:52 正常结束，两次三星结算分别在 00:13:25 和 00:14:46 被记录，最终 `TaskChainCompleted`、`AsstRunning=false`、`AsstDestroy` 返回齐备，进程已退出。用户确认「一致，后两次正常完成」。

见 [remaining-two.json](evidence/remaining-two.json)。两次执行共确认成功 **1＋2＝3**，没有药品/源石确认动作记录；不宣称完成了单一任务的三连验证。原生识别门槛的两轮通过证据见 [verified-home.json](evidence/verified-home.json) 与 [remaining-home.json](evidence/remaining-home.json)。

## 当前能确认和不能确认的事

| 项目 | 结论 |
|---|---|
| 版本、资源加载、窗口绑定、截图 | 已通过本机检查 |
| 单次返回按钮输入 | 实机有日志和截图支持 |
| 导航错误的原始记录与停止收尾 | 已取得一次证据；不是“战斗中主动停止”实验 |
| 三次目标与连续执行 | 累计 3/3；后一任务连续两次，用户确认一致 |
| 失败后不再开局 | 私有资源加载通过，实际战斗失败路径未验证 |
| 不吃药、不碎石 | 参数已限制；首轮没有到达相关操作，资源不足场景未验证 |
| TS → HTTP → Python → MaaCore 合并链路 | 未验证 |

这轮最直接的设计收益是区分“原生任务结束”“业务目标完成”“自动化已停止”：首轮原生任务全部结束，但业务目标未完成，停止收尾则有独立证据。后续适配器必须保留这种区分。

此外，DPI/资源初始化应由 MAA Adapter 负责，业务层只接收明确的执行事实；可选字段不应直接决定业务成败，完成量需要组合证据及去重。真实回调回放成为后续接口修改的回归材料，界面识别检查放在消耗理智的实验之前。后续先实现并验证 HTTP 合并层，再单独约定必要的实机次数；本轮不追加执行。

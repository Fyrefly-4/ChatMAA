# D2 执行契约与验证边界

2026-09-21 核对；实现从 `3183e07` 建立，当前基线 `3679f82`。三类确定参数操作、Backend 衔接及首轮 MuMu 基本通路已有证据，实机测试已结束，提交阶段审阅；环境、实测结果和未覆盖边界见[验证交付说明](d2-verification.md)。范围见 [D2 #21](https://github.com/Fyrefly-4/ChatMAA/issues/21)，业务含义沿用[协作约定](mvp-collaboration.md)。

## 入口与运行路径

D3 入口补充：下述裸参数提交须以 `--engineering` 启动 Backend；默认 MVP 通过[业务操作](d3-backend.md)形成方案并确认后调用相同任务服务。D2 参数与执行证据契约继续沿用，旧 Demo 使用显式兼容模式。

Backend 任务服务保存提交意图后调用 Python `/executions`；控制线程持久受理、占用设备，工作线程加载 MaaCore 并执行。查询、停止、租约、设备锁和退出交接仍走原入口。两端各写自己的 SQLite，不自动排队或重跑。模型不参与数量与停止判定。

本机服务默认由操作系统分配可用端口，避免随机命中 Windows 排除的端口而在就绪前失败；Backend 显式配置非零端口时仍使用指定端口。绑定地址与鉴权不变。

应用接口仍为 `POST /tasks`、`GET /tasks/:id`、`POST /tasks/:id/stop`。原次数请求保留；新请求在 params 内携带 `version: 2` 与操作类型。稳定 id 对应一次操作：同 ID 同参数只返回原任务，参数冲突拒绝；响应未知只查询原 ID。

确定参数客户端可用 `GET /device` 查询准入阻塞，使用 `POST /takeovers` 接入已有人工接管流程；两者沿用 `x-app-token` 鉴权，不开放匿名访问。接管请求为 `{id, confirmed: true, targets: [{id, seq}]}`，必须以用户已接管现场的明确确认和当前完整历史阻塞集合为依据。复核仅识别环境，成功后追加放行记录，不修改旧完成量、不重跑任务。当前执行、证据缺口、目标序号变化或环境复核失败仍拒绝放行。查询 `/device` 中的 recovery 判断原请求结果，不因响应丢失更换 ID 重发。

确定参数入口不代表已经实现 MVP 方案确认。现有模型工具仍保持旧固定次数范围，不开放新操作。D3 负责方案与确认、目标计算、材料—关卡适用性及业务结果，D4/D5 再接自然语言和页面。Web 仅增加避免将扫描／材料误显示为次数的兼容展示，不是完整 D5 界面。

## 请求样例

保存为 JSON 后，使用 `node backend/src/cli.ts submit-file <文件>`；查询和停止沿用 `get <ID>`、`stop <ID>`。CLI 读取 `CHATMAA_CONFIG` 配置及该目录中的 Backend 连接信息，提交前保存请求文件。必须核对实际运行模式；本节样例不构成实机授权。

```json
{"id":"scan-example","params":{"version":2,"kind":"scan_inventory"}}
```

```json
{"id":"count-example","params":{"version":2,"kind":"fight_count","stage":"1-7","count":2,"series":1,"medicine":0,"premium":0}}
```

```json
{"id":"material-example","params":{"version":2,"kind":"fight_material","stage":"1-7","item_id":"30012","quantity":3,"series":1,"medicine":0,"premium":0}}
```

次数与材料数量必须为正整数且不超过 MaaCore 有符号 int 范围。扫描不接受刷图字段，刷图不透传任意 Core JSON。材料操作只接一个材料、一个关卡；库存缺口由 Backend 计算，Adapter 不接目标总库存。

材料操作可显式附加 `max_count`，供独立开战上限的受控验证使用，映射到 Core 的 times。它不是估算出的材料目标或默认产品限制；未提供时使用 Core 表示上限。材料阈值或次数上限先触发者结束，达到次数上限不等于材料达标。实验还须单独约定理智消耗、时长和停止范围。

## 映射与限制

| 内容 | 当前映射与边界 |
|---|---|
| 扫描 | Depot；解析 DepotInfo.details.data JSON 字符串及 done，结合任务完成、错误和停止证据 |
| 次数 | Fight.times=count，不附加材料条件 |
| 材料 | Fight.drops={item_id: quantity}，每任务新建独立 Fight，不原地修改目标 |
| 资源限制 | medicine=0、medicine_expire_days=0、stone=0；client_type 为空，不启动客户端；关闭统计上报与 DrGrandet |
| 关卡 | 显式关卡码交给固定 Core 导航解析；不使用空关卡／当前／上次。参数受理不证明导航成功或关卡可代理 |
| 材料 ID | live 前核对安装资源 item_index.json；存在该 ID 不证明所选关卡掉落它，业务适用性归 D3 |
| 倍率 | 明确固定 series，表示范围 1–10；旧倍率资源可能只接收到 6，Core 拒绝时记录失败。合成样例覆盖单倍／双倍，实机尚未验证 |
| 计数 | 成功次数与批次数分开；固定倍率不能容纳剩余次数时可部分完成，不自动换倍率补足 |
| 掉落 | drops 为批次总量，不再乘倍率；相同 ID 多条汇总，与累计 stats 对照，stats 不逐事件相加 |

没有新增只支持 1-7 的产品白名单，也不宣称任意关卡、材料或倍率已验证。新增能力的实机覆盖集合目前为空；首轮从明确的小范围开始。掉落错误、应有结算缺失或冲突会请求停止，但异步处理不保证早于下一批开始，不承诺零超额。

## 结果怎样读取

公共快照保留 id、seq、state、时间、来源、停止与环境字段；v2 增加 operation、contract_version、interpretation_version。旧记录按旧解释读取，不改写历史结果。

| 字段 | 含义 |
|---|---|
| count_result | 成功次数 value、certainty、issues；精确 exact、下界 lower_bound 或冲突 unknown |
| material_result | 按材料 ID 的累计 items、certainty、issues，独立于次数可信度 |
| inventory_result | 已识别 items、complete、certainty、观察时间和 issues；缺失材料 unknown，不默认零 |
| threshold_reached | 本次执行目标条件有证据满足；不等于停止，不直接代表总库存达标 |
| confirmed | 旧入口兼容字段，始终为成功次数；扫描为 0，不能从此读取材料数 |
| automation_stopped | 执行及后续环境检查自动化已确认停止，不表示游戏战斗立即结束 |
| device、environment | 新操作准入及现场依据；停止或队列结束不能单独推出 ready |
| resource_digest | live v2 本次资源内容清单摘要，完整清单在本地 resources.json |

扫描只在最终结果、正常任务完成、停止确认且无错误／冲突时标 complete；这是识别结果，可靠性仍需在 MuMu 样本中核对。done=true 本身不能排除识别失败。缺失项不表示零。证据缺口、重启或留证失败会降低相关结果可信度，不能保留虚假的精确或完整标记。

精确完成 2/10 次可以是部分完成；材料可靠下界足够时可以满足阈值，但精确收获仍未知。reason=normal 仅表示未观察到显式中断，不能据此推断理智不足或材料达标。必须分别读取结果、可信度、停止与环境事实。

## MuMu 配置与桌面端

独立 Backend 通过 CHATMAA_CONFIG 读取配置；MuMu 不使用仍面向桌面 Demo 的自动窗口向导。

```json
{
  "mode": "maa-live",
  "installation": "D:/path/to/MAA",
  "connection": {
    "kind": "mumu",
    "adb": "D:/path/to/adb.exe",
    "address": "127.0.0.1:16384",
    "config": "MuMuEmulator12"
  }
}
```

路径和端口仅为示例。使用固定 v6.17.5 的 AsstAsyncConnect，不发现、启动、切换或关闭模拟器；不允许同时配置 connection 与 hwnd。旧桌面配置继续使用 installation＋hwnd。MuMu 不加载 PC 差异资源，设备锁共用。实际版本、输入及截图方式需在实机记录中核对，不能仅凭配置名宣布适配完成。

扫描的正常后置核对包含有限返回：识别仓库标签后，只允许匹配 Return 模板点击一次，再识别首页。它不调用 Fight，也不是通用返回循环；失败不放行。显式历史 recheck／takeover 仍只识别，不新增导航。首轮 MuMu 已通过扫描后首页识别并衔接次数任务；不保证任意游戏界面可返回。

桌面端保留既有能力，共用新增参数、证据和执行逻辑；其新增能力的专项实机验证可后补，不作为 D2 完成门禁。MuMu 结果不自动成为桌面端证据。

## 代码与检查入口

2026-09-21 接管同步修正（基于 `7d7b6cb`）：Backend 将“执行终止”和“证据已稳定”分开判断。仍阻塞新操作的历史任务继续周期同步，包括 ended／已停止但 needs_check 的记录；已完整同步并放行的历史才退出常规轮询，旧 unknown 事实不因此改写。启动未同步、证据缺口／冲突、单任务复核未停止均阻止提交；退出仍全量核对。沿用双库及 Adapter 的持久接管记录，不新增接管表，也不因恢复或丢失回执重发操作。

Backend `GET /device` 和浏览器状态的 `device` 在执行端事实之外增加 `admission`：`ready` 可受理，`blocked` 仍有执行／环境阻塞，`synchronizing` 执行端已解除阻塞但业务证据尚未满足放行条件，`unavailable` 服务正在退出或不可用。`conflictingTaskIds` 是业务侧阻塞范围；查询只描述当前状态，不预留执行资格，每次提交仍重新检查，Adapter 最终执行互斥检查。Web 和确定参数客户端应消费该汇总，不仅凭 recovery=succeeded 放行，也不要自行修改旧结果。

受控延迟回归见 `backend/tests/recovery-sync.test.ts`：POST 返回后才追加放行证据，覆盖多目标、ended／unknown 历史、丢失回执、服务状态重建、失败／停止不明及证据缺口。普通轮询完成同步后停止查询稳定历史；真实进程及同目录重启由既有 `takeover.test.ts` 联调覆盖，其等待不再调用强制全量同步。以上是离线证据，不替代 MuMu 实机验收。

- `adapter/maa/operations.py`：参数校验及 Core 映射；`connection.py`、`resources.py`：连接选择、资源清单与材料 ID 核对。
- `inventory.py`、`fight_evidence.py`：库存、次数和材料解释；`execution.py`：v2 执行与前后环境核对；原 native.py 继续提供停止会话和旧路径。
- `service.py`、`worker.py`：同一受理、记录、设备控制与操作分发；`operation_replay.py`：明确标识的合成 D2 回调。
- `backend/src/execution-contract.ts`、`task-service.ts`、`store.ts`：确定参数入口及投影；`cli.ts submit-file`：可独立检查的调用入口。

测试见 Adapter 的 connection、inventory、fight_evidence、operations_native、resources，以及 Backend 的 connection、d2 测试。命令沿用 [CI 说明](ci-plan.md)。Backend 联调使用真实 HTTP、控制层和双库，执行反馈是合成样例；native 测试替换 MaaCore 边界，不加载 DLL 或操作游戏。

maa-replay 下 v2 来源为 synthetic_d2_callbacks，旧请求继续使用已有脱敏回放；均不代表 MuMu 实机。原始回调、资源清单、参数、结果和停止时间记录在本地操作目录，私有配置及截图不发布。

已固定 MuMu／Android／游戏／Core／资源组合，核对扫描及有限返回、成功次数、材料阈值、普通停止、实际无药无石参数及连续衔接。自然掉落故障、异常停止实机延迟、其他倍率与超额未实测；分别列出已采集回调、离线注入及阻塞影响，见[验证交付说明](d2-verification.md)。

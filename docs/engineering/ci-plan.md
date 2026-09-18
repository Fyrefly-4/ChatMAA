# CI／GitHub Actions 实施方案

状态：方案已确认，尚未实施。最近核对：2026-09-18；方案更新前分支基线：`60dd554`，原评估代码基线：`732c169`。确认依据：PR #13 对应讨论中，项目负责人确认按需检查、三个独立模块、精确版本基线，以及先观察后强制。

本文是 CI 实施依据。当前尚无 `.github/workflows/`，定稿不表示工作流已运行、测试已通过或分支保护已启用。当前模块与验证边界仍以[工程说明](architecture.md)为准。

## 目标与现状

优先保证可扩展性与灵活性：后续功能 Issue 可便捷加入长期维护的检查，PR 根据改动影响选择检查。检查按模块或能力组织，不按 Issue 编号建立临时工作流。

Backend 已有 `npm run check`、`npm test` 与 npm 锁文件；Adapter 已有 `unittest` 与固定直接及传递依赖的 `requirements.lock`。Backend 测试会启动 Python Adapter，使用 `adapter/maa/.venv/Scripts/python.exe`，因此 Backend 测试 job 也必须安装 Python 及 Adapter 依赖；不同 job 不共享安装环境。

正式基线为 Windows、Node `>=24.18.0 <25`、Python 3.12，进程管理包含 Windows 语义。首期不建立长期跨平台或多版本矩阵。npm 锁文件指向 `registry.npmmirror.com`，实施时修正来源；Python 锁文件尚无哈希，后续增强。

## 工作流结构

采用统一调度、独立 reusable workflow 和统一门禁：

- `ci.yml`：PR／主分支触发、影响范围判定、检查调用及 `ci-gate` 汇总。
- `check-backend-types.yml`、`check-backend-tests.yml`、`check-adapter-tests.yml`：通过 `workflow_call` 接入，分别维护环境和命令。
- `ci-manual.yml`：统一手动入口，复用检查模块；使用独立结果名称，不生成 PR 门禁 `ci-gate`。

文件名为实施约定。调用与结果依赖使用显式 YAML，不引入自动发现模块的通用框架。重复环境准备可集中复用，不在多个 workflow 中复制版本值。

| 检查 | 环境 | 准备与命令 |
|---|---|---|
| `backend-types` | Node | 在 `backend/` 执行 `npm ci`、`npm run check` |
| `backend-tests` | Node + Python | 创建 `adapter/maa/.venv`，安装固定 pip 和 Adapter 锁定依赖，执行 `pip check`；在 `backend/` 执行 `npm ci`、`npm test` |
| `adapter-tests` | Python | 创建 venv，安装固定 pip 和 Adapter 锁定依赖，执行 `pip check`、`python -m unittest discover -s adapter/maa/tests -v` |

Python 命令显式使用相应 venv 的解释器。检查并行，各自设置 15 分钟超时；一项失败不提前终止其他检查。类型检查无需等待 Python 准备。首期按完整检查模块选择，不细分测试文件。

## 自动触发与影响范围

`pull_request` 面向默认分支，Draft 和 Ready PR 均自动反馈。创建、提交更新、目标分支调整按完整 PR 差异判断；仅转为 Ready 且代码与目标状态均未变化时，不专门重复运行。默认分支 `push` 运行全套离线检查。

同一 PR 更新取消旧运行；并发分组区分自动与手动入口，手动运行不能取消 PR 门禁。主分支保留逐次全套验证，不复用 PR 的取消策略。

调度入口在每个目标 PR 上触发，不通过顶层 `paths` 跳过整个必需工作流。集中维护路径规则，匹配结果取并集，并应用依赖联动：

| 改动范围 | 执行检查 |
|---|---|
| Backend 代码、测试、TS 配置、npm 依赖 | `backend-types`、`backend-tests` |
| Adapter 代码、测试、Python 依赖 | `backend-tests`、`adapter-tests` |
| 共用契约、回放数据等资源 | 所有受影响检查；边界不明确时全套 |
| 单个检查 workflow | 对应检查 |
| 公共 CI 配置、调度／汇总规则、手动入口、共享环境准备、版本基线 | 全套 |
| 明确列出的纯说明文档 | 跳过代码检查，摘要说明原因 |
| 未覆盖的路径 | 全套 |

以整个 PR 相对目标分支的改动判断，不能只看最后一次提交。删除纳入判断，重命名同时检查旧、新路径。纯文档使用明确的目录／文件清单，不通配忽略所有 Markdown；未来 Agent 提示词或运行资源可能使用 `.md`。文档例外与代码规则的优先级须明确，混合修改仍运行受影响检查。

差异缺失、截断或比较基线不可用时，若调度器仍正常则回退全套并记录原因；调度器自身失败不能产生通过结果。范围选择和门禁逻辑须进行针对性验证。

## 手动运行

`workflow_dispatch` 提供：

- `full`：全部离线检查。
- `custom`：布尔选项勾选任意组合，至少选择一项，否则报错。

首期不提供手动 `auto`，无需选择比较基线。手动局部结果用于调试，不代替 PR 门禁；不提供人为缩小 PR 必需范围的开关。新增模块时同步增加手动选项。

## 门禁与结果反馈

`ci-gate` 是后续唯一设为 required 的 CI 检查。依赖失败或跳过后仍执行核对，不能因普通 `needs` 传播而静默跳过：

- 选中检查必须成功；失败、取消、缺失或意外跳过均不能放行。
- 未选中检查允许按计划跳过。
- 调度器必须成功生成有效计划，未知或不完整计划不能默认为无需检查。
- 纯文档可不运行代码检查，但必须有有效范围判定和汇总。
- 整次运行取消不能转换为通过结论。

摘要展示运行项、跳过项、触发路径／联动原因、是否回退全套及最终结果。首期使用 Actions 日志和摘要排错，不自动重试测试失败；允许人工重跑失败项。

## 版本、依赖与缓存

采用精确固定验证基线、通过 PR 主动升级的策略：

| 对象 | 策略 |
|---|---|
| Node | 根目录 `.node-version` 指定精确版本，首期候选 `24.19.0`；所有相关检查读取同一来源 |
| Node 支持范围 | 保留 `package.json#engines` 的 `>=24.18.0 <25`，校验基线符合范围；单版本通过不表示整个范围已验证 |
| Python | 根目录 `.python-version` 指定精确补丁版本，首期候选 `3.12.14`；两个相关检查共用 |
| npm | 使用固定 Node 官方发行版附带版本，不自动升级，输出实际版本 |
| pip | 实施时确定可用精确版本并集中维护，不执行无限制的 `pip install --upgrade pip` |
| 项目依赖 | 按 npm／Python 锁文件安装，CI 不重新解析或升级依赖 |
| GitHub Actions | 固定完整 commit SHA，注释发布版本 |
| Windows runner | `windows-2025`，记录实际镜像版本；标签不会冻结镜像内容 |

Node、Python 候选来自本次核对的本地环境，不代表 CI 已通过。先验证 runner 可取得发行版、安装依赖并通过检查，再确认为基线；不可用时记录原因并重新确认替代值，不静默改为 `24.x`、`3.12` 或 `latest`。

使用官方 npm registry 修正锁文件来源，保持依赖版本不变并核对完整性信息，不同时升级依赖。缓存只优化依赖下载，不缓存 venv、工作区或测试结果；区分操作系统、实际语言版本与锁文件，安装步骤不能省略。输出 Node、npm、Python、pip 和镜像版本。

补丁及同系列升级通过独立 PR 修改版本来源、运行全套离线检查，评审后合并；安全更新优先处理。Node 主版本、Python 次版本升级单独评估，可临时增加候选检查，验证后替换基线。依赖升级与 CI 接入分开，不自动合并升级 PR。

## 权限与执行边界

- 顶层 `permissions: contents: read`，不使用 `pull_request_target`，不读取 secrets 或真实配置；差异判定优先使用 Git。
- 仅离线、替身／回放测试，不连接真实游戏、不加载 MaaCore DLL，不运行 live verification、管理员权限故障注入或现场确认。
- 不全量重跑历史原型作为门禁；正式入口在 `backend/` 与 `adapter/maa/`。
- 首期不上传 `.artifacts/`、SQLite、截图或本地配置。以后需要失败产物时另行确定脱敏和短保留期。
- 不包含发布、部署、版本打标或依赖自动合并。CI 通过不表示实机验收通过。

## 扩展约定

后续功能 Issue 新增检查时，同时包含：本地检查命令与 reusable workflow、影响范围与依赖关系、调度与手动选项、门禁结果依赖，以及触发／跳过／失败阻断验证。

例如 Web 接入后增加自身检查；共享 API 契约变更联动 Backend 与 Web。无需修改分支保护的 required 名称。Issue 与规格仍按[仓库 Issue 约定](../agents/issue-tracker.md)追踪。

## 实施顺序与验收

### 阶段 A：实现并观察，不强制门禁

1. 确认候选运行时可安装，确定 pip 版本与 Actions SHA；增加集中版本来源，修正 npm 锁文件来源。
2. 实现三个模块、集中范围规则、自动／手动入口与门禁。
3. 验证正常检查通过，类型错误与 Python 测试失败能被捕获，Backend 测试使用正确的 Python venv。
4. 验证两端单独修改、纯文档、混合修改、公共配置、未知路径、删除／重命名、多提交 PR 和差异读取异常的选择行为。
5. 验证必要检查失败、取消、缺失或意外跳过时门禁不通过；纯文档计划正确通过；手动空选择报错，局部运行不替代 PR 门禁。
6. 验证 fork PR 在无 secrets、只读 token 下运行。首次外部贡献者可能需仓库的 Actions 运行批准，不将等待误报为测试失败。
7. 观察至少 5 次有代表性的 PR／主分支运行，覆盖三个检查、按需跳过与主分支全套；保留运行链接和结论。重复同一简单案例不能替代场景覆盖。

本阶段 `ci-gate` 可报告失败，但尚不作为 required 阻止合并。不用自动重试掩盖测试不稳定。

### 阶段 B：确认后启用强制门禁

观察问题解决且验收满足后，再与项目负责人确认，将 `ci-gate` 设为默认分支唯一的 CI 必需检查。启用前核对检查名、最新提交结果和分支保护可用性。方案定稿及文档合并不代表立即切换强制状态。

若工作流自身故障持续阻断开发，保留失败记录并修复；确需临时取消 required 时明确记录原因，修复后恢复，不删除测试或扩大 token 权限。

### 后续维护

按需要评估 Python 带哈希锁定、Dependabot／Renovate 升级 PR、workflow 静态检查与依赖审查，确认工具功能及费用后再接入。只有明确跨平台支持目标时增加其他系统，不阻塞首期上线。

## 实施交接与未决验证

下一阶段产物：版本文件、锁文件来源修正、检查模块、调度／汇总逻辑及其验证。当前工程与测试状态仍未改变。

实施前尚需确认：候选 Node／Python 的 runner 可用性、pip 精确版本、Actions 发布版本与 SHA、纯说明文档及共用资源具体路径。尚无干净 GitHub runner 的通过记录，不能以原 PR 环境不匹配的失败推断修正环境后一定通过。

平台参考：[reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)、[required checks 与跳过行为](https://docs.github.com/en/enterprise-cloud%40latest/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)、[runner 选择](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job)。

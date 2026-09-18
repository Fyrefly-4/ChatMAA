# CI／GitHub Actions 实施方案

状态：简化结构已实现，本地完整检查和远端 Windows PR 验证通过，未启用强制门禁。最近核对：2026-09-18；修改前基线：`f0bc99e`。确认依据：项目负责人在本次讨论中同意单 workflow、单 Windows job、全量离线检查，并要求先写方案再实施及完成一轮本地和远端验证。实施追踪：[Issue #14](https://github.com/Fyrefly-4/ChatMAA/issues/14)。

## 目标与取舍

快速开发阶段优先降低 CI 的理解与维护成本，保留现有业务验证能力。每次运行全套检查，包括纯文档修改；暂不维护路径选择和检查组合。三项检查顺序执行、共用一次环境准备，减少重复安装；是否缩短等待时间以实际运行结果为准，不预先承诺提速。

## 执行结构

只保留 `.github/workflows/ci.yml`，包含一个名为 `offline-checks` 的 Windows job，超时 20 分钟。沿用两个环境准备 action，依次安装 Node、Backend 依赖、Python、固定 pip 和 Adapter 依赖，执行 `pip check`。保留精确版本、锁文件、下载缓存、Actions 完整 SHA、只读权限和 `persist-credentials: false`。

| 顺序 | 检查 | 命令 |
|---|---|---|
| 1 | Backend 类型 | `npm --prefix backend run check` |
| 2 | Backend 集成测试 | `npm --prefix backend test` |
| 3 | Adapter 单元测试 | `./adapter/maa/.venv/Scripts/python.exe -m unittest discover -s adapter/maa/tests -v` |

Backend 集成测试会启动 Python Adapter，必须先准备全部环境。环境准备失败则跳过检查；准备成功后，即使某项检查失败，也继续执行后续检查，除非运行被取消。检查不使用 `continue-on-error`，任何检查失败均使整个 job 失败，无独立汇总脚本。

## 触发与结果

- 面向 `main` 的 PR：opened、synchronize、reopened、edited 事件全量检查，覆盖目标分支调整；标题或描述修改也可能触发。Draft 和 Ready 一视同仁。
- `main` push：全量检查，验证合并结果。
- `workflow_dispatch`：无参数，全量检查。入口需进入默认分支后才能正式手动调用。
- 同一 PR 新运行取消旧运行；main 和手动运行使用各自 run ID，不互相取消。
- 本次保持非强制状态，不变更分支保护，不合并 PR。以后启用 required 时另行确认，并核对新的 `offline-checks` 检查名。

## 移除范围

删除三个 `check-*.yml` reusable workflow、`ci-manual.yml`、`plan.mjs`、`gate.mjs`、`policy.json` 和只验证这些已删除功能的 `ci.test.mjs`。删除 Node 准备 action 不再需要的可选安装参数。保留 `check-node.mjs` 和全部业务测试。同步更新 CI 维护说明与工程说明。

## 验证与完成条件

1. 先写入本方案，再实施配置与文档修改。
2. 按锁文件准备依赖，执行以上三项完整本地检查，并用 actionlint 检查工作流。
3. 核对环境失败、检查失败和取消时的条件表达式；不以容忍失败掩盖结果。
4. 推送当前 PR 分支，确认最新提交的远端 Windows job 完整执行三项检查且成功；记录提交、运行链接及实际结果。
5. 本轮不要求合并、开启强制门禁或完成 fork／main／手动入口的额外平台验收；这些未验证范围明确记录，不以 PR 运行代替。

只运行离线、替身／回放测试，不连接真实游戏、不加载 MaaCore DLL、不读取真实配置或 secrets。CI 通过不表示实机验收通过。依赖、解释器版本及业务代码不在本次升级范围。

## 后续扩展条件

某组测试实际拖慢反馈时拆 job；新增独立 Web 检查时按需要单独组织；无关变更反复触发昂贵检查时再评估路径选择；多个入口确实复用时再提取 reusable workflow；有明确跨平台支持目标时再增加矩阵。

## 历史依据与验证记录

原按需方案由本方案替代，原文和独有版本决策、验收证据保留在 [f0bc99e 历史版本](https://github.com/Fyrefly-4/ChatMAA/blob/f0bc99e/docs/engineering/ci-plan.md)。原方案的按需、custom、调度测试和五次代表性观察要求不再作为本次简化验收条件。旧记录按当时方案解读。

原方案 [Windows 运行 35346210732](https://github.com/Fyrefly-4/ChatMAA/actions/runs/35346210732) 成功，仅证明旧结构。新结构本地验证：Node 24.19.0 版本校验、Backend 类型检查、Backend 16 项集成测试、Adapter 25 项单元测试、pip check、actionlint 1.7.12 和 git diff --check 全部通过。npm ci 与 Python 锁定依赖安装完成；本地沿用 Python 3.12.14／pip 25.0.1，固定 Python 3.13.15／pip 26.2.1 由远端验证。首次本地提权命令解析到 Node 24.18.0，版本校验按预期拒绝，改用显式 PATH 的 24.19.0 后通过。远端 [运行 35347464772](https://github.com/Fyrefly-4/ChatMAA/actions/runs/35347464772) 对应实现提交 `3885229`，单个 Windows `offline-checks` job 在 1 分 24 秒内成功完成环境准备、类型检查、Backend 16 项和 Adapter 25 项测试。该结果证明 PR 路径与固定 CI 环境；main、手动、fork 触发未在本轮分别执行。

# CI／GitHub Actions 评估与落地方案

状态：建议采纳，尚未实施。最近核对：2026-09-18；代码基线：`732c169`。

本文只评估持续集成（CI）是否必要，并给出后续实施边界，不表示仓库已经配置了 GitHub Actions。当前模块、验证结论和运行边界仍以[工程说明](architecture.md)为准。

## 结论

**现在有必要配置最小 CI，优先级为高。** 仓库已经从实验材料发展为同时维护 TypeScript Backend 与 Python Adapter 的正式工程，两端都有可离线运行、失败时返回非零的自动化检查；继续仅依赖开发者手动执行，已经无法稳定保护跨语言契约、任务状态和进程交接行为。

建议先增加一个仅做离线验证的 GitHub Actions workflow，并把它作为合并前的必需检查。CI 不连接游戏，不加载 MaaCore，不使用真实配置、模型凭据或管理员权限，也不把实机验收替换成自动化测试。

## 现状与需求依据

| 核对项 | 当前事实 | 判断 |
|---|---|---|
| 自动化平台 | `.github/` 只有 PR 模板，没有 `.github/workflows/` | PR 当前没有统一的自动检查门禁 |
| Backend | `backend/package.json` 已提供 `npm run check` 和 `npm test`；`package-lock.json` 可供 `npm ci` 使用 | 已满足接入 CI 的基本条件 |
| Adapter | `adapter/maa/tests/` 使用标准库 `unittest`；`requirements.lock` 固定直接及传递依赖版本 | 可在不接触 MaaCore 的替身／回放边界运行 |
| 运行环境 | 正式基线是 Windows、Node `>=24.18.0 <25`、Python 3.12；宿主与子进程行为包含 Windows 语义 | 首个必需检查应在 `windows-latest` 上执行，不能只用 Linux 结果代替 |
| 安全边界 | 正式测试默认离线，实机流程有明确授权、次数与环境要求 | 自动 CI 只运行离线检查；真实游戏操作必须继续由人工明确授权 |
| 依赖可重复性 | npm 与 Python 均有锁文件；但 npm 锁文件中的 tarball 地址当前指向 `registry.npmmirror.com`，Python 锁文件没有哈希 | 能起步，但应先处理外部镜像依赖，并随后增强供应链校验 |

CI 的直接价值是：

1. 在 PR 合并前统一验证类型检查、Backend 测试和 Adapter 测试，避免“本地只跑了其中一端”。
2. 固定与项目声明一致的 Node／Python 主版本，尽早暴露开发机版本漂移。
3. 为分支保护提供稳定的 required checks；当前没有可配置为门禁的工作流结果。
4. 为后续 Web、Agent Runtime 或跨语言协议变更提供可扩展入口，而不是每次重新约定检查方式。

## 推荐的最小方案

### 1. 触发与权限

新增 `.github/workflows/ci.yml`：

- `pull_request`：面向默认分支的所有 PR；
- `push`：默认分支上的提交，覆盖合并后的最终状态；
- `workflow_dispatch`：仅用于人工重跑同一套离线检查；
- 顶层设置 `permissions: contents: read`，不授予写权限；
- 使用 `concurrency` 按 workflow 与 ref 取消同一 PR 的旧运行；
- 为 job 设置 15 分钟 `timeout-minutes`，避免子进程异常时长期占用 runner；
- 不使用 `pull_request_target`，不读取 secrets，不上传 `.artifacts/` 中的运行数据。

### 2. 两个并行的必需 job

| Job 名称 | Runner 与版本 | 步骤 | 预期结果 |
|---|---|---|---|
| `backend` | `windows-latest`；Node 24，并在安装后检查满足 `>=24.18.0 <25` | checkout → setup Node/npm cache → `npm ci`（`backend/`）→ `npm run check` → `npm test` | 类型检查与 Backend 离线测试全部通过 |
| `adapter` | `windows-latest`；Python 3.12 | checkout → setup Python/pip cache → 建立 venv → `python -m pip install -r adapter/maa/requirements.lock` → `python -m pip check` → `python -m unittest discover -s adapter/maa/tests -v` | 依赖一致，Adapter 离线／替身测试全部通过 |

两个 job 应并行，名称保持稳定，随后在默认分支保护中设为 required。Actions 应固定到完整 commit SHA，并由 Dependabot 或 Renovate 提交升级 PR；不要只长期依赖可移动的 major tag。

初期不建议加入矩阵：项目正式支持基线仍是单一 Windows 环境，先让必需检查准确覆盖该承诺，比同时增加未经定义的 Linux、macOS 或多版本兼容目标更重要。若未来明确跨平台开发支持，再将 Ubuntu 作为额外的快速检查，而不是反过来用 Ubuntu 代替 Windows。

### 3. 实施前置修正

首个 workflow PR 应同时完成以下事项，否则 CI 的稳定性和依赖来源不清晰：

1. 在受控环境用官方 npm registry 重新生成并核对 `backend/package-lock.json`，或明确记录继续使用镜像的维护责任；不应让 GitHub-hosted runner 隐式依赖个人开发环境生成的镜像地址。
2. 给正式工程增加单一 Node 版本来源（例如仓库根目录 `.node-version`），同时保留 `package.json#engines` 的范围校验，避免 workflow、文档与本地命令分别漂移。
3. 在 GitHub Actions 上确认 `windows-latest` 当前镜像可以取得指定 Node 24 与 Python 3.12；workflow 中输出 `node --version`、`npm --version` 和 `python --version` 便于追溯。
4. 首次启用后观察至少 5 次 PR／默认分支运行；只有重复失败确认为环境抖动时才调整缓存或重试，不用自动重试掩盖测试不稳定。

## 明确不放进 CI 的内容

- 不运行 Backend README 中的 live verification，也不连接 Windows 官方客户端、MAA DLL、设备或游戏账号。
- 不进行真实刷图、前后界面识别、管理员权限故障注入或现场确认。
- 不把原型目录中的历史实验全量重跑作为合并门禁；原型是历史证据，正式检查入口在 `backend/` 与 `adapter/maa/`。
- 不在第一阶段上传 SQLite、日志、截图或本地配置。若以后为失败诊断上传产物，须先证明内容已脱敏，并设置短保留期且仅在失败时上传。
- 不在第一阶段加入自动发布、部署、版本打标或依赖自动合并。CI 与发布权限应分开设计。

## 分阶段落地与验收

### 阶段 A：建立门禁（当前建议）

1. 完成 npm 锁文件来源和 Node 版本文件的前置修正。
2. 添加上述单一 workflow 和两个 Windows job。
3. 验证 fork PR 在无 secrets、只读 token 下可以通过。
4. 将 `backend`、`adapter` 设为默认分支 required checks，要求分支保持最新后才能合并。

验收标准：PR 修改任一端代码时两项检查均会运行；正常代码通过；人为制造的 TypeScript 类型错误或 Python 测试失败会阻止合并；运行过程不访问真实执行环境。

### 阶段 B：供应链与维护

在阶段 A 稳定后，再分别评估：

- 为 `requirements.lock` 引入带哈希的可重复安装流程；
- 配置 Dependabot／Renovate 更新 npm、pip 和 GitHub Actions 固定 SHA；
- 增加 workflow YAML 静态检查及依赖审查，但先确认私有／公开仓库功能和费用限制；
- 只在确有跨平台支持目标时添加 Ubuntu job。

阶段 B 不应阻塞最小 CI 上线，也不改变正式实机验收范围。

## 风险与回退

| 风险 | 控制方式 |
|---|---|
| Windows runner 更新导致环境漂移 | 显式 setup 语言版本、输出版本、固定 Actions SHA；runner 标签变化单独审阅 |
| 缓存掩盖依赖问题 | 安装继续使用锁文件和 `npm ci`；缓存仅优化下载，不缓存工作区或测试结果 |
| 子进程测试残留或挂死 | job 超时；测试继续使用临时目录与离线配置；失败后不运行 live 清理 |
| 外部 registry 短时不可用 | 使用明确的官方来源和锁文件；不通过降低检查强度解决 |
| CI 被误解为实机通过 | job、README 与 PR 模板均明确标记“离线检查”，实机结论仍单独记录 |

若新 workflow 在修复自身配置后仍阻断所有开发，应暂时取消 required 状态，而不是删除测试或扩大 token 权限；保留失败记录，修复后再恢复门禁。

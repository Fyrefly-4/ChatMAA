# CI 使用与接入

最近核对：2026-09-19；原配置基线：`126808c`，本次在 Issue #10 分支增加 Web 检查。本文是日常运行和新增检查的维护入口；路径沿用 `ci-plan.md`，实施过程见 [归档方案](../archive/2026-09-ci/ci-plan.md)。

## 当前如何运行

[CI workflow](../../.github/workflows/ci.yml) 使用单个 Windows `offline-checks` job，超时 20 分钟。所有触发都运行全套离线检查，包括纯文档修改。

| 入口 | 行为 |
|---|---|
| 面向 `main` 的 PR | opened、synchronize、reopened、edited 时运行，Draft 和 Ready 相同；调整目标分支或修改标题、描述也可能触发 |
| `main` push | 检查合并后的状态 |
| 手动 `workflow_dispatch` | 无参数运行全套；workflow 进入默认分支后可从 Actions 页面选择分支运行 |

同一 PR 的新运行取消旧运行；main 和手动运行各自使用 run ID，不互相取消。Node、Python 和两端依赖各准备一次，增加 Web 依赖及配套 Chromium 准备，然后执行 Backend 类型检查、Backend 集成测试、Adapter 单元测试、Web 类型检查、构建和浏览器检查。Web 准备失败不阻止已准备好的 Backend／Adapter 检查；Web 构建失败时不运行浏览器检查。

环境准备失败时跳过检查；准备成功后，一项检查失败仍继续后续检查，除非运行被取消。任何检查失败都使 job 失败。排错时查看对应 step 的日志，可在 Actions 页面重跑失败的 job；由于只有一个 job，重跑会重新准备环境并执行全套检查。

截至上述基线，未启用强制门禁。以后设为 required 前，应另行确认并核对检查名 `offline-checks`。本轮已验证 PR 路径；main、手动和 fork 入口尚未分别验证。CI 仅运行离线、替身／回放测试，通过不表示实机验收通过。

## 本地运行相同检查

在仓库根目录使用 PowerShell，先准备版本文件指定的 Node 和 Python。版本以 [.node-version](../../.node-version)、[.python-version](../../.python-version)、[.pip-version](../../.pip-version) 为准，依赖分别以 [npm 锁文件](../../backend/package-lock.json) 和 [Python 锁文件](../../adapter/maa/requirements.lock) 为准。

按以下顺序准备环境；任何命令失败都应先修复再继续：

```powershell
node scripts/ci/check-node.mjs
python -c "import pathlib,platform; assert platform.python_version()==pathlib.Path('.python-version').read_text().strip()"
npm --prefix backend ci --registry=https://registry.npmjs.org
python -m venv adapter/maa/.venv
$pipVersion = (Get-Content .pip-version -Raw).Trim()
& ./adapter/maa/.venv/Scripts/python.exe -m pip install --index-url https://pypi.org/simple "pip==$pipVersion"
& ./adapter/maa/.venv/Scripts/python.exe -m pip install --index-url https://pypi.org/simple -r adapter/maa/requirements.lock
& ./adapter/maa/.venv/Scripts/python.exe -m pip check
```

Backend 集成测试也会启动 Python Adapter，不能省略 Python 准备。已有 venv 应与指定 Python 版本一致。CI 的环境准备实现见 [setup-node](../../.github/actions/setup-node/action.yml) 和 [setup-python](../../.github/actions/setup-python/action.yml)。

另安装 Web 依赖和浏览器，再执行各项检查，并检查各自的退出状态：

```powershell
npm --prefix web ci --registry=https://registry.npmjs.org
node web/node_modules/playwright/cli.js install chromium
npm --prefix backend run check
npm --prefix backend test
& ./adapter/maa/.venv/Scripts/python.exe -m unittest discover -s adapter/maa/tests -v
npm --prefix web run check
npm --prefix web run build
npm --prefix web run test:e2e
```

## 后续如何接入

| 场景 | 接入方式 |
|---|---|
| 为现有模块增加测试 | 确认现有命令能发现新测试，通常无需修改 workflow。Backend 当前匹配 `backend/tests/*.test.ts`；Adapter 从 `adapter/maa/tests` 执行 unittest discovery，默认匹配 `test*.py` |
| 增加一种检查 | 先提供本地可运行且失败返回非零退出码的命令，再在 `offline-checks` 中增加有明确名称的 step |
| 增加新模块，例如 Web | 增加锁定依赖的安装和检查命令；按实际依赖与耗时判断是否沿用当前 job，新增准备步骤也要纳入检查条件 |
| 修改运行时或依赖 | 更新对应版本文件或锁文件，必要时同步环境准备 action；Node 的 `engines` 范围格式改变时也需同步 `check-node.mjs` |

新增检查 step 可沿用现有条件，在两端准备成功且未取消时执行；这样前一项检查失败不会挡住后续检查：

```yaml
- name: 新检查
  if: ${{ !cancelled() && steps.node.outcome == 'success' && steps.python.outcome == 'success' }}
  run: npm --prefix backend run <检查脚本名>
```

将示例命令替换为已实现的检查命令；若增加其他准备步骤，补充它们成功的条件。环境准备步骤保持默认的成功条件。不要用 `continue-on-error` 将必要检查的失败变成成功。

新增检查沿用离线边界、只读权限、Actions 完整 SHA、精确版本和锁文件。缓存用于下载加速，不代替安装与检查；不接入真实游戏、真实配置、secrets 或部署。

## 修改后如何验证

- 修改 workflow 或 composite action 后，运行 `actionlint`，并核对准备失败、检查失败及取消时的条件。
- 新增或修改检查命令、依赖、版本或准备逻辑后，执行完整本地检查，再验证远端 Windows job。
- 核对远端运行的提交和结论，确认每个预期检查 step 实际执行且成功，不能只看 workflow 已触发。
- 运行 `git diff --check`，更新本文中受影响的命令、入口和验证范围。仅整理文档时检查链接和内容一致性即可。

## 何时扩展结构

某组测试明显拖慢反馈时再拆 job；多个入口确实复用相同检查时再提取 reusable workflow；无关修改反复触发昂贵检查时再评估路径选择；有明确跨平台或多版本支持目标时再增加矩阵。新增模块本身不要求引入上述全部机制。

## 历史与证据

取舍、原按需方案的历史入口及首轮验证保留在 [实施方案归档](../archive/2026-09-ci/ci-plan.md)。基线 `126808c` 的 [Windows PR CI](https://github.com/Fyrefly-4/ChatMAA/actions/runs/35347687701) 全部通过，单 job 用时 1 分 20 秒；本次文档整理不代表重新执行这些检查。

2026-09-19 Web 接入：本地 actionlint、Backend／Web 类型检查、构建、Adapter 回归及 Edge Chromium 浏览器离线检查通过。模型替身与正式回放、独立展示夹具分别覆盖；没有使用真实模型或游戏。本分支未创建 PR 或触发 workflow_dispatch；分支推送不匹配现有 main push 条件，远端 Windows job 尚未验证。后续须核对实际运行提交和全部 Web steps，不能用本地结果替代远端结论。

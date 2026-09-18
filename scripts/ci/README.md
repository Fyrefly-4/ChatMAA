# CI 运行与维护

实施状态、验收和启用门禁的时机见[CI 方案](../../docs/engineering/ci-plan.md)。本目录不控制实机执行。

## 检查入口

- 自动入口：`.github/workflows/ci.yml`。Draft／Ready PR 按完整差异选择，默认分支提交全套。`edited` 事件也运行，以覆盖目标分支调整；标题／描述修改因此也可能触发一次检查。
- 手动入口：`.github/workflows/ci-manual.yml`，选择 `full` 或 `custom`；后者至少勾选一项。工作流合入默认分支后可从 Actions 页面选择分支并运行。结果名称为 `manual-result`，不替代 `ci-gate`。
- 调度自检：仓库根目录执行 `node --test scripts/ci/ci.test.mjs`，无 npm 依赖。自动／手动调度均先执行自检。
- 类型：`npm --prefix backend run check`；Backend 测试：`npm --prefix backend test`；Adapter：使用 venv 的 Python 执行 `-m unittest discover -s adapter/maa/tests -v`。

先按根目录 `.node-version`、`.python-version` 准备解释器，按 `.pip-version` 安装 pip。Backend 测试需要 `adapter/maa/.venv/Scripts/python.exe`；环境准备见 `.github/actions/`，不要依赖全局 Python 或跨 job 共享环境。

## 范围与门禁

`policy.json` 集中列出检查名、纯文档清单和代码规则。文档例外先匹配，其他规则取并集；未分类文件全套。只有指定文档目录中的 `.md` 和精确列出的文档文件可跳过；例如 `backend/prompts/system.md` 仍视为代码输入。`docs/agents/`、新目录、公共 CI 配置与版本文件均走全套。

`plan.mjs` 用 Git merge-base 与 PR head 计算完整差异，按 NUL 格式解析，保留删除和重命名旧／新路径；失败回退全套。检查执行仍使用 Actions 默认 PR merge checkout，以验证合并结果。空差异同样保守全套。

`gate.mjs` 验证调度成功、计划结构完整，以及每项实际结果与计划相符。必要检查的失败、取消、缺失和意外跳过均失败。工作流摘要显示选择原因与汇总结论。检查失败时可在 Actions 重跑失败项；更新 PR 会取消旧运行。不要用自动重试掩盖测试问题。

## 新增检查

1. 增加可本地运行的检查命令，以及固定环境的 `check-*.yml` reusable workflow。
2. 在 `policy.json` 增加检查名、路径规则和依赖联动；公共契约必须覆盖调用方。
3. 在自动及手动 workflow 中增加计划输出、条件调用、汇总 `needs`，手动入口增加布尔选项。
4. 调整本目录测试覆盖新检查组合，验证相关修改触发、无关修改跳过、失败不能放行。
5. 使用 actionlint 核对工作流；记录代表性 Actions 运行。不改变唯一 required 名称 `ci-gate`。

版本或共享准备逻辑变更运行全套。检查模块使用只读权限与完整 Actions SHA，不引入部署、模型凭据或游戏环境。

# CI 辅助脚本

CI 运行方式、本地命令、新增检查和验证要求统一见 [CI 使用与接入](../../docs/engineering/ci-plan.md)。

本目录的 `check-node.mjs` 在仓库根目录执行，校验当前 Node 是否与 `.node-version` 精确一致，并检查该版本是否满足 `backend/package.json` 的 `engines.node`。不一致时返回非零退出码。

```powershell
node scripts/ci/check-node.mjs
```

该脚本由 [Node 环境准备 action](../../.github/actions/setup-node/action.yml) 调用。修改 `engines.node` 的范围表达格式时同步调整校验逻辑。

## 文档与 workflow 检查

在仓库根目录运行：

```powershell
node scripts/ci/check-doc-links.mjs
node --test scripts/ci/check-doc-links.test.mjs
./scripts/ci/check-workflows.ps1
```

`check-doc-links.mjs` 使用 `git ls-files` 获取文档及允许链接的文件集合，检查常见 Markdown 内联链接、图片、引用定义的本地文件或目录目标。支持相对路径、仓库根路径和 URL 编码；跳过代码围栏、行内代码、远端 URL 和锚点。发现不存在或未跟踪的目标时，以文件、行号报告并返回非零状态。新增文件需先暂存；本检查不验证外部链接、标题锚点、HTML 链接或全部 Markdown 语法。

`check-workflows.ps1` 下载 actionlint 1.7.12 的 Windows x64 包，核对固定 SHA-256 后执行 workflow 静态检查。可用 `-ActionlintPath <actionlint.exe路径>` 复用已核实的本地工具。它关闭可选 ShellCheck／Pyflakes 集成，本仓库的 PowerShell 运行语义及 composite action 完整内容仍需单独核对和远端验证。

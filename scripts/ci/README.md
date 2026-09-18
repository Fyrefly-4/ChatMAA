# CI 辅助脚本

CI 运行方式、本地命令、新增检查和验证要求统一见 [CI 使用与接入](../../docs/engineering/ci-plan.md)。

本目录的 `check-node.mjs` 在仓库根目录执行，校验当前 Node 是否与 `.node-version` 精确一致，并检查该版本是否满足 `backend/package.json` 的 `engines.node`。不一致时返回非零退出码。

```powershell
node scripts/ci/check-node.mjs
```

该脚本由 [Node 环境准备 action](../../.github/actions/setup-node/action.yml) 调用。修改 `engines.node` 的范围表达格式时同步调整校验逻辑。本目录不再维护路径调度或独立门禁脚本。

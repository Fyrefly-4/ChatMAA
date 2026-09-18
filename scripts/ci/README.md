# CI 运行与维护

当前方案、取舍和验证记录见 [CI 方案](../../docs/engineering/ci-plan.md)。

## 运行入口

`.github/workflows/ci.yml` 在面向 main 的 PR、main push 和手动触发时运行全套离线检查，纯文档变更也运行。手动入口无参数，工作流进入默认分支后可用。同一 PR 更新取消旧运行，main 和手动运行不会互相取消。

单个 Windows `offline-checks` job 共用一次环境准备，依次执行：

```powershell
npm --prefix backend run check
npm --prefix backend test
& ./adapter/maa/.venv/Scripts/python.exe -m unittest discover -s adapter/maa/tests -v
```

本地先按 `.node-version`、`.python-version` 准备解释器；`npm --prefix backend ci` 安装 Backend 依赖。Python 在 `adapter/maa/.venv` 创建环境，按 `.pip-version` 安装 pip，再安装 `adapter/maa/requirements.lock` 并执行 `pip check`。完整准备命令见 `.github/actions/`。Backend 测试也依赖该 Python 环境。

环境准备失败时停止；准备成功后，一项检查失败不阻止后续检查，取消除外。任何检查失败仍使 job 失败。Actions 日志按三个 step 分别查看；无路径调度、custom 模式或独立门禁汇总。目前不启用强制检查，未来 required 名称需核对 `offline-checks`。

## 修改与扩展

现有命令自动发现的新测试无需额外配置 CI。新增检查命令时，在 job 中增加 step；若要在前一检查失败后仍执行，沿用已有的准备成功与未取消条件，不使用 `continue-on-error`。环境准备步骤保持默认成功条件。

修改工作流后执行 actionlint；版本和准备逻辑变化后运行完整本地检查并验证远端 Windows job。保留锁文件、精确版本、Actions SHA、下载缓存、只读权限和超时。不要引入真实游戏、配置、secrets 或部署步骤。

仅当耗时或模块独立性带来实际需求时再拆 job、增加路径选择或提取 reusable workflow，具体条件见 CI 方案。

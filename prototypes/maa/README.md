# 真实 MAA 原型

对应 [Issue #4](https://github.com/Fyrefly-4/ChatMAA/issues/4)，结果与时间线见 [REPORT.md](REPORT.md)。范围为 Windows 官方桌面端、官服 `1-7`、单局代理、不吃药、不碎石；这是接口与执行证据实验，不是正式产品入口。

## 当前进度

本轮累计 **3/3 成功**，用户现场确认一致：第一局成功后因初版计数解析过严提前停止，修复后建立关联新任务，剩余两局连续完成并正常收尾。验证了单局及两局连续执行，没有将它写成单一任务三连成功。

过程中修复了 Python 宿主缺少 DPI 感知与 `cur_times` 可选字段的解析问题；诊断改为离线回放和原生识别门槛，减少重复实机试跑。当前没有运行中的原型进程，不追加游戏操作。

原始记录不覆盖：初版结果、修正后的解释及依据分别保存。现场截图和完整回调仅留本地，提交内容为脱敏摘要。

HTTP 合并代码和离线回放入口已补齐，模块图、结果边界及下一轮待确认方案见 [HTTP-MERGE.md](HTTP-MERGE.md)。尚未追加实机调用。

## 如何运行与停止

当前统一入口为管理员 PowerShell 中的 `verify-and-run-admin.ps1`。它先核对旧执行收尾，再运行原生主界面识别探针，匹配通过后才启动受限战斗；两阶段分别保存日志，失败时停在对应阶段。

本次剩余两次使用的命令（已完成，保留作实验记录，不重复运行）：

```powershell
& '.\prototypes\maa\verify-and-run-admin.ps1' -Remaining
```

运行前回到游戏主界面，确认官方 MAA 任务已停止。运行期间不同时操作游戏。需要停止时，在执行终端按 **Ctrl+C**；战斗阶段也可在另一个终端运行 `prototypes/maa/stop.ps1`。停止请求不等于停止确认，应等待 `automation_not_running` 和最终 `result`。自动化已停止不表示游戏内战斗立即结束。

每个入口对应固定的一次性证据目录，已有目录时拒绝重放；不要删除目录重试。未完成或结果未知时先核对，不自动补刷。终端关闭或强制退出可能留下未知部分。运行入口退出码 `0` 表示计数证据匹配（仍待现场核对），`1` 表示运行/记录异常，`2` 表示目标未完成。

安装位置与 Python 路径放在被忽略的 `.artifacts/local-config.json`，字段为 `installation`、`python`。原型读取安装目录资源与热更新缓存，不修改 MAA GUI 的任务设置。需要 GUI 配置、资源版本或环境变化时，先核对差异。

## 模块与职责

| 文件 | 职责 |
|---|---|
| `core.py` | 对齐官方 GUI 的 system DPI 感知、加载资源、调用 C ABI、记录回调与销毁实例 |
| `contract.py` | 受限参数、失败即停覆盖、只识别探针配置、完成量解释 |
| `recognize_home.py` | 实际走主界面截图识别路径；任务动作只有 Stop，没有按钮点击或导航 |
| `run.py` | 单轮战斗、进度、停止请求、收尾与关联旧任务 |
| `verify-and-run-admin.ps1` | 一个命令串联识别门槛和受限执行 |
| `diagnose_screenshot.py` | 对已保存截图离线计算模板相关度，不连接游戏；需 Pillow、NumPy |
| `test_contract.py` | 参数限制、真实回调回放、缺证据与重复事件检查 |
| `preflight.py` / `preflight-admin.ps1` | 基础绑定与静态截图检查；不能代替真实识别门槛 |
| `run-first/second/third-three-admin.ps1` | 已执行过的历史入口，保留用于解释实验，不重复使用 |

## 证据如何解释

- 同一任务中，关联 `FightTimes.series=1`、`StartButton2` 点击完成、`EndOfAction` 结算识别和 `StageDrops` 的 `1-7` 三星结果，才计入一局成功。
- `cur_times` 是可选字段。缺少它时可由上述完整证据链确认单局；若它出现但不为 1，或倍率、开战、结算证据缺失，则保留未知。按开战序号去重，不因重复接收结算增加次数。
- `AllTasksCompleted` 可以伴随 `TaskChainError`，不能独立代表成功。`AsstStop` 返回、`AsstRunning=false`、`AsstDestroy` 返回也分别记录。
- 私有失败规则仅覆盖 `Fight@…` 的已识别代理/战斗失败节点，修改为 Stop 并清空后继；不修改安装资源。规则加载通过不等于实际失败场景通过。
- `manifest.json` 记录参数、版本/哈希和任务关联；`events.jsonl` 保存原始回调；`result.json` 保存执行时解释。重新解释历史记录写入新文件，不回写原结果。

## 验证与限制

```powershell
python -m unittest discover -s prototypes/maa -p test_contract.py -v
```

目前 9 项离线检查通过，包括真实单局回调缺少 `cur_times` 的回归用例。DPI 修复后主界面原生识别、单局及两局连续执行、正常收尾已有实机证据和用户现场确认。战斗中的主动停止、资源不足、战斗失败路径以及 TS → HTTP → Python → MaaCore 合并链路仍需独立验证。替身实验见 [lifecycle/REPORT.md](../lifecycle/REPORT.md)，不能直接视为实机保证。

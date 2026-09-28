# MVP 用户启动入口

2026-09-26，基于 D6 分支。适用已准备依赖的 Windows＋MuMu 环境。

## 日常使用

1. 双击根目录 `启动 ChatMAA.bat`。首次自动读取工程 Python、运行中的 MuMu／MAA 安装位置和 MuMu 实例配置；单实例自动选择，多实例需用户选择。填写或核对 MAA 和模型配置，保存后启动。ADB 路径、端口和 Python 路径位于高级设置，仅发现失败时需要手动补充。MuMu 应已启动，游戏由用户登录并准备好。
2. 网页就绪后自动打开。日常无需设置环境变量或复制启动地址；启动窗口可再次打开网页。
3. 在网页正常交流、查看方案并确认任务。启动本身不提交游戏任务。
4. 结束时点击启动窗口的“停止并退出”，等待“已完成证据交接，执行端已退出”，再关闭窗口并核对游戏现场。关闭网页不会退出服务；窗口关闭按钮也先请求正常退出。

启动前由 PowerShell 检测运行环境：Node 优先读取已保存路径，再检查 `.artifacts/runtimes/node/node.exe`、NVM 对应版本目录和 PATH；Python 优先核对执行配置中的路径，再检查保存路径、工程 `.venv`、`.artifacts/runtimes/python/python.exe` 和 PATH。只接受仓库版本文件指定的版本，Python 同时检查 x64 与 fastapi/uvicorn。没有合格候选时打开运行环境窗口，显示版本和路径诊断，提供重新检测与文件选择。选择成功后保存绝对路径，不自动安装或修改系统 PATH。

首次依赖安装沿用 [环境准备](demo.md#首次准备)：Node、Python、Backend 依赖和 Web 构建须已准备好。预检只报告缺项，不自动安装。前端更新后需重新构建。

## 配置和记录

- `.artifacts/mvp/runtime.json`：启动器使用的 Node／Python 绝对路径。Python 会同步到当前执行配置；所有正常启动和本地验收工具应复用同一选择逻辑。路径失效时重新检测。
- `.artifacts/mvp/config.json`：固定执行配置，包含 Python、MAA、MuMu 地址；默认复用 `.artifacts/live` 的业务数据。
- 根目录 `.env`：`CHATMAA_MODEL_BASE_URL`、`CHATMAA_MODEL_API_KEY`、`CHATMAA_MODEL_ID`。首次表单沿用已有三项值，并保留其他配置；密钥输入隐藏。修改模型可编辑此文件后重启。进程环境中的同名值优先，应避免残留旧值。
- 双击根目录 `设置 ChatMAA.bat` 可依次打开运行环境与应用配置窗口；适合首次检查和后续调整，不启动 Backend。请在服务退出后修改，保存后下次启动生效。窗口提供“重新检测”和文件浏览，保留既有数据目录及其他执行配置。
- `.artifacts/launcher/run-*/launcher.jsonl`：带时间的启动、错误、退出记录。“查看记录”打开本轮目录。
- 同目录 `session.json`：启动状态、数据目录、最终交接和本机网页地址；含浏览器令牌，仅本地使用，不直接分享。

环境／依赖预检在启动器互斥之前完成，失败原因直接显示在窗口，并记录在本轮日志中。启动器用 Windows 命名管道防止重复启动，持有进程退出时由系统释放，异常退出也不会留下永久锁；旧 `.artifacts/mvp/launcher.lock` 不再读取，可保留作历史记录。

Adapter 的设备互斥和业务中的历史不确定状态保持原职责。启动器退出并不证明游戏自动化已停止；若 Backend 或 Python 仍存活，设备互斥仍会拒绝冲突执行。交接失败时保留记录并按原流程核对执行端及任务事实，不清空业务数据。

## 结构与验证

`启动 ChatMAA.bat` 调用 `scripts/launcher/start.ps1` 的 Windows Forms 窗口。窗口启动 `backend/src/launcher.ts`，后者先调用 `mvp-preflight.ts` 预检，再通过 `launcher-guard.ts` 获取进程存续期间的互斥，负责记录以及调用原 `/shutdown`；`configure.ps1` 提供配置表单，`discovery.py` 从已有路径、进程路径和 `.nemu` 实例文件只读发现连接参数（迁自 D2 本地工具，不依赖私人目录）。发现不代表实例已启动或连接可用，也不扫描端口、调用 ADB 或切换实例；`mvp-entry.ts` 做依赖与 Python 预检后进入 `main.ts --runtime --web`。Python 生命周期、业务处理和双库归属仍由原 Backend／Adapter 管理。

开发检查可向 PowerShell 脚本传 `-Config <回放配置绝对路径> -NoModel -SessionDirectory <记录目录>`，默认用户入口始终读取保存的 live 配置，不自动切换为回放。预检复用旧 Demo 的纯文件检查函数，不进入旧 Demo 模式。

正式回放覆盖启动、MVP 页面状态、无模型、重复启动拒绝、无任务副作用和退出交接；测试位于 `web/tests/mvp-launcher.spec.ts`。真实模型、MuMu 和首次配置窗口的人工体验仍需 D6 现场验收。

2026-09-26 自动发现补充：迁入的发现测试覆盖错误播放器路径修复、旧端口排除、多实例、损坏配置和非法端口；配置窗口夹具检查单实例自动选择、多实例人工选择及未发现时的高级设置。已在本机只读发现 MuMu ADB 和实例地址；未连接游戏。新增测试通过 Backend 测试入口运行。

2026-09-26 运行环境与互斥修正：保存路径在空 PATH 下复用、错误版本拒绝、候选回退、重复占用拒绝、进程异常退出自动释放，以及历史连接文件存在时预检失败后重试均已通过离线检查。实际 PowerShell 窗口＋本地 D6 脚本的无模型回放正常交接通过；不代表真实游戏验收。

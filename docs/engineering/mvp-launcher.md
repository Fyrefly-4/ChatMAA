# MVP 用户启动入口

2026-09-26，基于 D6 分支。适用已准备依赖的 Windows＋MuMu 环境。

## 日常使用

1. 双击根目录 `启动 ChatMAA.bat`。首次在窗口填写 Python、MAA、MuMu ADB 地址与模型配置，保存后启动。MuMu 应已启动，游戏由用户登录并准备好。
2. 网页就绪后自动打开。日常无需设置环境变量或复制启动地址；启动窗口可再次打开网页。
3. 在网页正常交流、查看方案并确认任务。启动本身不提交游戏任务。
4. 结束时点击启动窗口的“停止并退出”，等待“已完成证据交接，执行端已退出”，再关闭窗口并核对游戏现场。关闭网页不会退出服务；窗口关闭按钮也先请求正常退出。

首次依赖安装沿用 [环境准备](demo.md#首次准备)：Node、Python、Backend 依赖和 Web 构建须已准备好。预检只报告缺项，不自动安装。前端更新后需重新构建。

## 配置和记录

- `.artifacts/mvp/config.json`：固定执行配置，包含 Python、MAA、MuMu 地址；默认复用 `.artifacts/live` 的业务数据。
- 根目录 `.env`：`CHATMAA_MODEL_BASE_URL`、`CHATMAA_MODEL_API_KEY`、`CHATMAA_MODEL_ID`。首次表单沿用已有三项值，并保留其他配置；密钥输入隐藏。修改模型可编辑此文件后重启。进程环境中的同名值优先，应避免残留旧值。
- 修改设备路径可在服务退出后编辑 `config.json`；要重新运行首次表单，可先备份并移走该配置文件，保留业务数据。
- `.artifacts/launcher/run-*/launcher.jsonl`：带时间的启动、错误、退出记录。“查看记录”打开本轮目录。
- 同目录 `session.json`：启动状态、数据目录、最终交接和本机网页地址；含浏览器令牌，仅本地使用，不直接分享。

重复启动被本地锁阻止。启动窗口异常消失后，不自动清锁、结束进程或更换数据目录；先按 [退出与检查](demo.md#退出与检查) 对原配置请求关闭并核对 Backend、Python 和游戏现场，确认后才移除 `.artifacts/mvp/launcher.lock`。业务中的历史不确定状态仍通过原有环境核对处理。

## 结构与验证

`启动 ChatMAA.bat` 调用 `scripts/launcher/start.ps1` 的 Windows Forms 窗口。窗口启动 `backend/src/launcher.ts`，后者负责防重复启动、记录以及调用原 `/shutdown`；`mvp-entry.ts` 做依赖与 Python 预检后进入 `main.ts --runtime --web`。Python 生命周期、业务处理和双库归属仍由原 Backend／Adapter 管理。

开发检查可向 PowerShell 脚本传 `-Config <回放配置绝对路径> -NoModel -SessionDirectory <记录目录>`，默认用户入口始终读取保存的 live 配置，不自动切换为回放。预检复用旧 Demo 的纯文件检查函数，不进入旧 Demo 模式。

正式回放覆盖启动、MVP 页面状态、无模型、重复启动拒绝、无任务副作用和退出交接；测试位于 `web/tests/mvp-launcher.spec.ts`。真实模型、MuMu 和首次配置窗口的人工体验仍需 D6 现场验收。

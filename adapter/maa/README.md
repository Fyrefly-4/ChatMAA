# MAA Adapter 持久化执行服务

Python 控制层在单进程中提供本机 HTTP 受理、查询、停止及退出交接。MaaCore 在工作线程执行，控制线程统一写 `executor.sqlite`；工作线程只发反馈，不直接写执行库。执行函数与环境识别见 `native.py`、`readiness.py`。

同一 ID 和参数返回原记录，不重复执行；ID 参数冲突拒绝。稳定序号支持增量查询，重启后未知状态不自动恢复。实例身份、控制者租约、设备锁及有界退出约束执行权；普通停止不因持久化失败而丢失停止信号。启动不连接游戏，只有显式 live 提交才调用 MaaCore；离线模式使用正式控制层和 SQLite，仅替换游戏执行。

`settings.py` 接收 `CHATMAA_ADAPTER_CONFIG`：mode、data、controller、token 及可选租约/退出窗口；live 还要求 installation、hwnd。live 使用固定 `.artifacts/live/` 并持有仓库设备锁；原型目录存在时兼容持有其锁。`main.py` 绑定 loopback 随机高端口并报告实例身份，上层宿主管理协议将在 Backend 中接入。不可用新目录或新 ID 猜测恢复旧执行。

准备：`py -3.12 -m venv adapter/maa/.venv`，然后 `adapter/maa/.venv/Scripts/python.exe -m pip install -r adapter/maa/requirements.lock`。

验证：在仓库根目录运行 `adapter/maa/.venv/Scripts/python.exe -m unittest discover -s adapter/maa/tests -v`。覆盖参数与执行替身、控制层记录失败、重启保守恢复及设备锁。依赖固定在 requirements.lock；检查不操作游戏。真实行为不能由离线检查推定。

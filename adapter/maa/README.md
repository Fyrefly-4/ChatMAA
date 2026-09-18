# MaaCore 封装与证据解释

本目录独立承接 `273055d` 的 `prototypes/maa/core.py`、`contract.py` 和脱敏回调样例；保留原型目录。生产代码与样例保持原内容，仅测试导入和样例相对路径适配正式目录。本步骤不引入服务、工作线程或新的游戏行为。

Core 封装 Windows 公共 C ABI；contract 解释已确认完成量，任务队列结束不等于成功次数。当前保留原型最多三次的参数边界，正式执行策略由后续能力建立。

在仓库根目录使用 Python 运行 `python -m unittest discover -s adapter/maa/tests -v`。这些检查只读脱敏回调并验证参数与证据解释，不加载 MaaCore、不操作游戏。验证不要求 FastAPI 或模型凭据。

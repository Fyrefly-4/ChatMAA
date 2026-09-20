# MuMu 首轮回调摘录

2026-09-21，MaaCore v6.17.5。四份 JSON 来自同轮库存扫描、1-7 单倍次数任务、固源岩目标任务及开战后停止任务。按已批准 D2 方案整理为脱敏解释器回归样例；不是新运行，也不替代原始实机证据。

只保留 Depot／Fight 开始结束、DepotInfo、FightTimes、StartButton2、EndOfAction、StageDrops 的必要字段和原顺序。移除设备 UUID、绝对时间、路径、截图、OCR 坐标和原始字符串；taskid 统一为 7，时间改为相对回调起点。库存保留两个物品的出现时序，数量分别替换为样例 5 和 72，其余库存删除；这些数量不是玩家实际库存。保留首个页面的非空性质，不因脱敏制造空页异常。战斗的本次掉落和单倍计数保留，物品名称删除。

这些样例证明当前解释器能够读取已观察的回调形式：单倍 StageDrops 没有 cur_times、结算插件先于 EndOfAction 完成、库存需要最终 done 与任务结束、停止可以留下已开始未结算周期。`test_mumu_capture.py` 离线重放这些事件，另对掉落做明确的缺失／UNKNOWN_DROP 注入，经过正式 native 执行循环检查停止调用。注入结果不证明真实 OCR 故障的触发概率或停止耗时。

运行 `adapter/maa/.venv/Scripts/python.exe -m unittest discover -s adapter/maa/tests -p test_mumu_capture.py -v`。原 `operation_replay.py` 继续作为任意请求的合成联调驱动，来源仍是 synthetic_d2_callbacks；这里的实机摘录不被冒充为任意关卡／倍率的真实执行。

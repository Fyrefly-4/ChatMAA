"""HTTP 工作线程：重用 CLI 的 native 路径；离线模式只重放脱敏回调。"""
import copy
import json
import os
from pathlib import Path
import time

from contract import summarize

ROOT = Path(__file__).resolve().parent


def replay(count, stop, emit, faults):
    # 这里只把一次真实回调复制为多个明确标注的合成周期，不声称新增实机证据。
    fixture = json.loads((ROOT / "evidence/verified-first-battle.json").read_text(encoding="utf-8"))["events"]
    events = []
    emit("worker_started", {})
    for cycle in range(1, count + 1):
        for original in fixture:
            if stop.wait(float(faults.get("tick_ms", 90)) / 1000):
                break
            event = copy.deepcopy(original)
            data = event["details"].get("details", {})
            if "exec_times" in data:
                data["exec_times"] = cycle
            if faults.get("invalid_drop") and event["details"].get("what") == "StageDrops":
                data["stars"] = 2
            events.append(event)
            emit("progress", summarize(events, 1, count))
            if faults.get("invalid_drop") and summarize(events, 1, count)["count_unknown"]:
                stop.set()
        if stop.is_set():
            break
    if stop.is_set():
        # 模拟阻塞调用位于工作线程，HTTP / 租约仍应响应。
        time.sleep(float(faults.get("stop_delay_ms", 0)) / 1000)
    else:
        events.append({"kind": "callback", "at": time.time(), "message": 10002,
                       "details": {"taskchain": "Fight", "taskid": 1}})
    result = summarize(events, 1, count)
    result.update(automation_stopped=True, asst_running_false_observed=True, destroy_returned=True,
                  reason="user_stop" if stop.is_set() else "normal", evidence_source="offline_callback_replay")
    return result


def execute(mode, operation, stop, emit, faults, grant):
    try:
        # 独立于两端任务表的工作线程调用观测；实验可检查是否真正进入过两次。
        with (Path(os.environ["LAB_DATA"]) / "worker-audit.jsonl").open("a", encoding="utf-8") as audit:
            audit.write(json.dumps({"kind": "worker_entered", "id": operation["id"], "mode": mode, "at": time.time()}) + "\n")
            audit.flush()
            os.fsync(audit.fileno())
        if mode == "maa-replay":
            result = replay(operation["params"]["count"], stop, emit, faults)
        else:
            # 此导入不加载 DLL；只有通过受理、一次性授权核对后才会进入 main。
            from run import main
            output = ROOT / ".artifacts" / grant["output"]
            emit("worker_started", {})
            main(["--installation", grant["installation"], "--hwnd", str(grant["hwnd"]),
                  "--count", str(operation["params"]["count"]), "--output", str(output)],
                 stop_requested=stop, on_progress=lambda value: emit("progress", value),
                 device_lock_held=True)
            result = json.loads((output / "result.json").read_text(encoding="utf-8"))
            result["evidence_source"] = "MaaCore_v6.17.5"
        emit("finished", result)
    except BaseException as error:
        # 包括初始化失败；没有最终停止证据时不能推定已经停止。
        emit("worker_error", {"error": repr(error)})

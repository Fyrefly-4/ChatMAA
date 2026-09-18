"""脱敏回调回放；只替换游戏动作，控制层及 SQLite 使用正式实现。"""
import copy
import json
from pathlib import Path
import time
from contract import summarize


def replay(operation, stop, emit, output):
    fixture = json.loads((Path(__file__).parent / "fixtures/verified-first-battle.json").read_text(encoding="utf-8"))["events"]
    events = []
    count = operation["params"]["count"]
    emit("worker_started", {})
    for cycle in range(1, count + 1):
        for original in fixture:
            if stop.wait(0.03):
                break
            event = copy.deepcopy(original)
            data = event["details"].get("details", {})
            if "exec_times" in data:
                data["exec_times"] = cycle
            events.append(event)
            emit("progress", summarize(events, 1, count))
        if stop.is_set():
            break
    if not stop.is_set():
        events.append({"kind": "callback", "at": time.time(), "message": 10002,
                       "details": {"taskchain": "Fight", "taskid": 1}})
    result = summarize(events, 1, count)
    result.update(automation_stopped=True, reason="user_stop" if stop.is_set() else "normal",
                  evidence_source="offline_callback_replay",
                  environment={"ready": not stop.is_set(), "observed_at": time.time(), "basis": "offline_fixture"})
    (output / "events.json").write_text(json.dumps(events), encoding="utf-8")
    return result

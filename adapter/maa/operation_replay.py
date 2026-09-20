"""明确标识的合成 D2 回调样例，不充当 MuMu 或真实识别证据。"""
import json
import time
from execution import projection


def replay_operation(operation, stop, emit, output):
    params = operation["params"]
    chain = "Depot" if params["kind"] == "scan_inventory" else "Fight"
    events = []

    def event(message, data=None, what=None):
        events.append({"kind": "callback", "at": time.time(), "message": message,
                       "details": {"taskchain": chain, "taskid": 1, "what": what, "details": data or {}}})
        emit("operation_progress", projection(events, 1, params))

    emit("worker_started", {})
    if chain == "Depot":
        if not stop.wait(0.03):
            event(20003, {"done": False, "data": json.dumps({"30012": 72})}, "DepotInfo")
        if not stop.wait(0.03):
            event(20003, {"done": True, "data": json.dumps({"30012": 72})}, "DepotInfo")
    else:
        target = params.get("count", params.get("quantity"))
        quantity, count, index = 0, 0, 0
        item_id = params.get("item_id", "30012")
        while not stop.is_set() and (count < target if params["kind"] == "fight_count" else quantity < target):
            # Fixed series may finish below an indivisible count target, as Core does.
            if params["kind"] == "fight_count" and count + params["series"] > target:
                break
            if params.get("max_count") is not None and count + params["series"] > params["max_count"]:
                break
            index += 1
            for message, data, what in [(20003, {"series": params["series"]}, "FightTimes"),
                                        (20002, {"task": "StartButton2", "exec_times": index}, None),
                                        (20001, {"task": "EndOfAction"}, None)]:
                if stop.wait(0.03):
                    break
                event(message, data, what)
            if stop.is_set():
                break
            quantity += 2 * params["series"]
            count += params["series"]
            event(20003, {"stage": {"stageCode": params["stage"]}, "stars": 3, "cur_times": params["series"],
                          "drops": [{"itemId": item_id, "quantity": 2 * params["series"]}],
                          "stats": [{"itemId": item_id, "quantity": quantity}]}, "StageDrops")
            event(20002, {"task": "EndOfAction"})
    if not stop.is_set():
        event(10002)
    result = projection(events, 1, params, True)
    result.update(automation_stopped=True, reason="user_stop" if stop.is_set() else "normal",
                  evidence_source="synthetic_d2_callbacks",
                  environment={"ready": not stop.is_set(), "observed_at": time.time(), "basis": "synthetic_d2_fixture"})
    (output / "events.json").write_text(json.dumps(events), encoding="utf-8")
    return result

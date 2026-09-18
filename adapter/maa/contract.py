"""参数及保守证据解释；承接原型 273055d，不执行 native 调用。"""
import json
from pathlib import Path

FAILURE_NODES = {"PrtsErrorConfirm", "AbandonAction", "FightMissionFailed", "FightMissionFailedAndStop"}
MAX_COUNT = 2_147_483_647  # v6.17.5 FightTask::set_params reads times as int.


def fight_params(count):
    if type(count) is not int or not 1 <= count <= MAX_COUNT:
        raise ValueError("次数必须是 MaaCore int 范围内的正整数")
    return {"stage": "1-7", "times": count, "series": 1,
            "medicine": 0, "medicine_expire_days": 0, "stone": 0,
            "client_type": "", "server": "CN", "DrGrandet": False,
            "report_to_penguin": False, "report_to_yituliu": False}


def write_failure_overlay(output: Path):
    directory = output / "failure-policy/resource/tasks"
    directory.mkdir(parents=True)
    # 前缀任务跨资源重载仍会存在，必须显式声明识别方式，避免回退到
    # Fight@AbandonAction.png 等不存在的模板。沿用固定版本的原识别区域。
    patch = {}
    for name in sorted(FAILURE_NODES):
        recognition = ({"algorithm": "MatchTemplate", "template": name + ".png"}
                       if name in {"AbandonAction", "PrtsErrorConfirm"}
                       else {"algorithm": "OcrDetect", "text": ["行动失败"]})
        patch["Fight@" + name] = {"baseTask": name, **recognition, "action": "Stop",
                                 "sub": [], "next": [], "onErrorNext": [],
                                 "exceededNext": [], "reduceOtherTimes": []}
    (directory / "tasks.json").write_text(json.dumps(patch, indent=2), encoding="utf-8")
    return output / "failure-policy"


def write_home_probe_overlay(output: Path):
    directory = output / "home-probe/resource/tasks"
    directory.mkdir(parents=True)
    # 沿用 Fight 的主界面识别，但彻底移除输入动作、导航子任务与后继。
    patch = {"Fight": {"action": "Stop", "sub": [], "next": [],
                       "onErrorNext": [], "exceededNext": []}}
    (directory / "tasks.json").write_text(json.dumps(patch, indent=2), encoding="utf-8")
    return output / "home-probe"


def summarize(events, task_id, requested):
    observed = 0
    drops = []
    errors = []
    complete = False
    count_unknown = False
    pending_series = None
    cycles = {}
    active_cycle = None
    for event in events:
        if event.get("kind") != "callback":
            continue
        detail = event.get("details") or {}
        if detail.get("taskchain") != "Fight" or detail.get("taskid") != task_id:
            continue
        message = event.get("message")
        data = detail.get("details") or {}
        node = data.get("task", "").split("@")[-1]
        if message in (10000, 20000) or (message == 20001 and node in FAILURE_NODES):
            errors.append({"at": event["at"], "message": message, "node": node,
                           "subtask": detail.get("subtask"), "first": detail.get("first"),
                           "pre_task": detail.get("pre_task"), "what": detail.get("what"), "why": detail.get("why")})
        if message == 10002:
            complete = True
        if message == 20003 and detail.get("what") == "FightTimes":
            pending_series = data.get("series")
        if message == 20002 and node == "StartButton2":
            cycle_id = data.get("exec_times")
            active_cycle = cycle_id if type(cycle_id) is int and cycle_id > 0 else None
            if active_cycle is not None and active_cycle not in cycles:
                cycles[active_cycle] = {"series": pending_series, "ended": False, "drop_signature": None}
            pending_series = None
        if message == 20001 and node == "EndOfAction" and active_cycle in cycles:
            cycles[active_cycle]["ended"] = True
        if message == 20003 and detail.get("what") == "StageDrops":
            count = data.get("cur_times")
            cycle = cycles.get(active_cycle)
            signature = json.dumps(data, sort_keys=True, ensure_ascii=False)
            duplicate = cycle is not None and cycle["drop_signature"] == signature
            valid_count = "cur_times" not in data or (type(count) is int and count == 1)
            valid = (cycle is not None and cycle["ended"] and type(cycle["series"]) is int
                     and cycle["series"] == 1 and cycle["drop_signature"] is None
                     and data.get("stage", {}).get("stageCode") == "1-7" and data.get("stars") == 3
                     and valid_count)
            drops.append({"at": event["at"], "stage": data.get("stage"), "stars": data.get("stars"),
                          "cur_times": count, "cycle": active_cycle, "usable": valid, "duplicate": duplicate,
                          "basis": "observed single series + start + settlement" if valid else None})
            if valid:
                observed += 1
                cycle["drop_signature"] = signature
            elif not duplicate:
                count_unknown = True
    return {"interpretation_version": 2, "requested": requested, "observed_successes": observed, "stage_drop_evidence": drops,
            "started_cycles": len(cycles),
            "unsettled_cycles": sum(cycle["drop_signature"] is None for cycle in cycles.values()),
            "task_chain_completed": complete, "errors": errors, "count_unknown": count_unknown,
            "matches_requested_evidence": complete and not errors and not count_unknown and observed == requested,
            "onsite_verification": "pending"}

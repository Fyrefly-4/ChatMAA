"""按执行内周期核对次数与掉落，保持部分完成和材料阈值相互独立。"""
import json
from contract import FAILURE_NODES


def quantities(values):
    if not isinstance(values, list):
        raise ValueError("missing quantities")
    result = {}
    for item in values:
        if (not isinstance(item, dict) or not isinstance(item.get("itemId"), str) or not item["itemId"]
                or type(item.get("quantity")) is not int or item["quantity"] < 0
                or item.get("dropType") == "UNKNOWN_DROP"):
            raise ValueError("invalid quantity")
        result[item["itemId"]] = result.get(item["itemId"], 0) + item["quantity"]
    return result


def summarize_fight(events, task_id, params, stopped=False):
    cycles, active, series = {}, None, None
    count, totals = 0, {}
    errors, count_issues, material_issues = set(), set(), set()
    completed = False
    starting = False
    for event in events:
        detail = event.get("details") or {}
        if event.get("kind") != "callback" or detail.get("taskchain") != "Fight" or detail.get("taskid") != task_id:
            continue
        message = event.get("message")
        data = detail.get("details") or {}
        node = data.get("task", "").split("@")[-1]
        if message in (10000, 20000) or (message == 20001 and node in FAILURE_NODES):
            errors.add("execution_or_recognition_error")
        if message == 10002:
            completed = True
        if message == 20003 and detail.get("what") == "FightTimes":
            series = data.get("series")
        if message == 20001 and node == "StartButton2":
            starting = True
        if message == 20002 and node == "StartButton2":
            starting = False
            cycle_id = data.get("exec_times")
            if type(cycle_id) is not int or cycle_id <= 0:
                count_issues.add("invalid_cycle_identity")
                active = None
                continue
            if cycle_id not in cycles:
                if active is not None and cycles[active]["signature"] is None:
                    count_issues.add("missing_previous_settlement")
                    material_issues.add("missing_previous_settlement")
                cycles[cycle_id] = {"series": series, "ended": False, "signature": None}
            active = cycle_id
        cycle = cycles.get(active)
        if message == 20001 and node == "EndOfAction" and cycle is not None:
            cycle["ended"] = True
        # Core invokes the drop plugin before emitting EndOfAction completion.
        if message == 20002 and node == "EndOfAction" and cycle is not None and cycle["signature"] is None:
            material_issues.add("missing_settlement_drops")
        if message != 20003 or detail.get("what") != "StageDrops":
            continue
        signature = json.dumps(data, sort_keys=True)
        if cycle is not None and cycle["signature"] == signature:
            continue
        if cycle is None or not cycle["ended"] or cycle["signature"] is not None:
            count_issues.add("unmatched_or_conflicting_settlement")
            material_issues.add("unmatched_or_conflicting_settlement")
            continue
        cycle["signature"] = signature
        batch = data.get("cur_times")
        # Missing cur_times has only been evidenced for an explicitly observed single series.
        if batch is None and cycle["series"] == 1:
            batch = 1
        valid_count = (type(batch) is int and type(cycle["series"]) is int
                       and batch == cycle["series"] == params["series"]
                       and data.get("stage", {}).get("stageCode") == params["stage"]
                       and data.get("stars") == 3)
        if not valid_count:
            count_issues.add("invalid_settlement_count_or_stage")
            material_issues.add("invalid_settlement_count_or_stage")
            continue
        count += batch
        try:
            drops = quantities(data.get("drops"))
            stats = quantities(data.get("stats"))
            expected = dict(totals)
            for key, value in drops.items():
                expected[key] = expected.get(key, 0) + value
            if expected != stats:
                raise ValueError("cumulative mismatch")
            totals = expected
        except ValueError:
            material_issues.add("invalid_or_conflicting_drop_totals")
    unsettled = sum(c["signature"] is None for c in cycles.values()) + int(starting)
    if stopped and unsettled:
        count_issues.add("unsettled_cycles")
        material_issues.add("unsettled_cycles")
    # A stopped, complete ledger can be exact even if the requested target wasn't reached.
    count_exact = stopped and not unsettled and not count_issues and not errors
    material_exact = count_exact and not material_issues
    conflict = "unmatched_or_conflicting_settlement" in count_issues
    count_result = {"value": count, "certainty": "unknown" if conflict else "exact" if count_exact else "lower_bound", "issues": sorted(count_issues | errors)}
    material_result = {"items": totals, "certainty": "unknown" if conflict else "exact" if material_exact else "lower_bound", "issues": sorted(material_issues | errors)}
    reached = (count >= params["count"] if params["kind"] == "fight_count"
               else totals.get(params["item_id"], 0) >= params["quantity"])
    return {"interpretation_version": 3, "count_result": count_result, "material_result": material_result,
            "threshold_reached": reached and not conflict, "task_chain_completed": completed,
            "started_cycles": len(cycles), "unsettled_cycles": unsettled,
            "errors": sorted(errors | count_issues | material_issues)}

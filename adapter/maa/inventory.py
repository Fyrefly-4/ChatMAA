"""固定 v6.17.5 DepotInfo 的累计扫描结果解释；缺失项不代表零。"""
import json


def summarize_inventory(events, task_id, stopped=False):
    items = {}
    final = None
    completed = False
    errors = []
    observed_at = None
    for event in events:
        detail = event.get("details") or {}
        if event.get("kind") != "callback" or detail.get("taskchain") != "Depot" or detail.get("taskid") != task_id:
            continue
        message = event.get("message")
        if message in (10000, 20000):
            errors.append("depot_execution_error")
        if message == 10002:
            completed = True
        if message != 20003 or detail.get("what") != "DepotInfo":
            continue
        data = detail.get("details") or {}
        try:
            # v6.17.5 emits a JSON string, not an item array.
            values = json.loads(data["data"])
            if (not isinstance(values, dict) or not values or type(data.get("done")) is not bool
                    or any(not isinstance(k, str) or not k or type(v) is not int or v < 0 for k, v in values.items())):
                raise ValueError("invalid inventory")
        except (KeyError, TypeError, ValueError):
            errors.append("invalid_depot_info")
            continue
        # Every callback is a cumulative snapshot; never sum them or overwrite conflicts.
        if any(values.get(k) != v for k, v in items.items()) or (final is not None and values != final):
            errors.append("conflicting_depot_info")
            continue
        items = values
        observed_at = event.get("at")
        if data["done"]:
            final = values
    if completed and final is None:
        errors.append("missing_final_inventory")
    reliable = stopped and completed and final is not None and not errors
    return {"inventory_result": {"items": items, "complete": bool(reliable),
                                 "certainty": "recognized" if reliable else "unknown",
                                 "missing_items": "unknown", "observed_at": observed_at,
                                 "issues": sorted(set(errors))},
            "task_chain_completed": completed, "errors": sorted(set(errors)),
            "interpretation_version": 3}

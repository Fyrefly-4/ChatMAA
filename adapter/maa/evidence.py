"""执行中断或留证失败时统一降级新增结果，不修订原始事件。"""
def uncertain(snapshot, issue):
    changes = {}
    for key in ("count_result", "material_result", "inventory_result"):
        if key not in snapshot:
            continue
        value = snapshot[key]
        changes[key] = {**value, "certainty": "unknown" if key == "inventory_result" or value.get("certainty") == "unknown" else "lower_bound",
                        "issues": sorted(set(value.get("issues", [])) | {issue})}
        if key == "inventory_result":
            changes[key]["complete"] = False
    return changes

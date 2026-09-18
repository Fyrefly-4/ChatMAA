"""只读本轮原始记录，导出脱敏证据；不导入或调用 MaaCore。"""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3

ROOT = Path(__file__).resolve().parent


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def read_lines(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def database(path, table, evidence_table):
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        row = dict(connection.execute(f"SELECT * FROM {table}").fetchone())
        return {"snapshot": json.loads(row["snapshot"]), "cursor": row.get("cursor"),
                "gap": bool(row.get("gap", False)), "quick_check": connection.execute("PRAGMA quick_check").fetchone()[0],
                "event_sequences": [item[0] for item in connection.execute(f"SELECT seq FROM {evidence_table} ORDER BY seq")]}
    finally:
        connection.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--onsite-note", required=True, help="本轮用户的真实现场确认原文")
    args = parser.parse_args()
    native = ROOT / ".artifacts/http-merge-first"
    data = ROOT.parent / "lifecycle/.artifacts/http-merge-first/data"
    manifest = read_json(native / "manifest.json")
    result = read_json(native / "result.json")
    handoff = read_json(data / "handoff-result.json")
    events = read_lines(native / "events.jsonl")
    transport = read_lines(data / "timeline.jsonl")
    sanitized = []
    resource_nodes = set()
    for event in events:
        kind = event["kind"]
        if kind in {"start_returned", "observed_progress", "stop_requested", "stop_returned",
                    "automation_not_running", "destroy_returned"}:
            sanitized.append({key: event[key] for key in ("kind", "at", "accepted", "reason", "count", "requested") if key in event})
        if kind != "callback":
            continue
        detail = event.get("details") or {}
        if detail.get("taskchain") != "Fight":
            continue
        values = detail.get("details") or {}
        node = values.get("task", "").split("@")[-1]
        if any(token in node for token in ("Medicine", "Stone", "Sanity")):
            resource_nodes.add(node)
        if node not in {"StartButton2", "EndOfAction"} and detail.get("what") not in {"StageDrops", "FightTimes"}:
            continue
        entry = {"kind": "callback", "at": event["at"], "message": event["message"],
                 "node": node or None, "what": detail.get("what"),
                 "details": {key: values[key] for key in ("exec_times", "series", "times_finished", "stars", "cur_times") if key in values}}
        if values.get("stage"):
            entry["details"]["stageCode"] = values["stage"].get("stageCode")
        sanitized.append(entry)
    business = database(data / "business.sqlite", "tasks", "evidence")
    executor = database(data / "executor.sqlite", "executions", "events")
    fields = ("state", "confirmed", "certainty", "automation_stopped", "started_cycles", "unsettled_cycles", "device")
    checks = {
        "live_mode": handoff["mode"] == "live",
        "expected_stop_scenario": handoff["stopScenarioObserved"],
        "two_database_results_match": all(business["snapshot"][key] == executor["snapshot"][key] for key in fields),
        "all_evidence_transferred": business["event_sequences"] == executor["event_sequences"] == list(range(1, 9)) and business["cursor"] == 8 and not business["gap"],
        "shutdown_handoff_complete": any(event.get("kind") == "shutdown_handoff" and event.get("complete") for event in transport),
        "shutdown_confirmed_by_driver": handoff["shutdownConfirmed"],
        "python_exit_zero": any(event.get("kind") == "child_exit" and event.get("code") == 0 for event in transport),
    }
    evidence = {"operation": "http-merge-first", "mode": "live", "source_revision": "8a93824",
                "core_version": manifest["core_version"], "core_sha256": manifest["core_sha256"], "params": manifest["params"],
                "home_probe": read_json(ROOT / ".artifacts/http-merge-home/result.json"),
                "native_result": result, "native_timeline": sanitized,
                "resource_related_nodes_observed": sorted(resource_nodes),
                "business": business, "executor": executor,
                "worker_entries": len(read_lines(data / "worker-audit.jsonl")), "checks": checks,
                "onsite_verification": {"status": "confirmed", "statement": args.onsite_note},
                "screenshot_review": "停止后截图为黑帧，不作为游戏战斗状态证据；使用回调及现场确认。",
                "raw_sha256": {name: hashlib.sha256((native / name).read_bytes()).hexdigest() for name in ("events.jsonl", "result.json")}}
    destination = ROOT / "evidence/http-merge-first.json"
    destination.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"checks": checks, "worker_entries": evidence["worker_entries"], "output": str(destination)}, ensure_ascii=False))
    return 0 if all(checks.values()) and evidence["worker_entries"] == 1 else 1


if __name__ == "__main__":
    raise SystemExit(main())

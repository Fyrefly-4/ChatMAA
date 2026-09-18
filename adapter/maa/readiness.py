"""只识别环境，不点击、不导航。新判据必须另获实机证据。"""
import json
from pathlib import Path
import time

READY_TTL_SECONDS = 5
PROBE_NODES = {"ChatMAAReadyHome", "ChatMAAReadyStage"}


def write_readiness_overlay(output: Path):
    directory = output / "readiness-policy/resource/tasks"
    directory.mkdir(parents=True)
    patch = {}
    for name, base in (("ChatMAAReadyHome", "Fight"), ("ChatMAAReadyStage", "StartButton1")):
        patch[name] = {"baseTask": base, "action": "Stop", "sub": [], "next": [],
                       "onErrorNext": [], "exceededNext": [], "reduceOtherTimes": [],
                       "preDelay": 0, "postDelay": 0}
    # v6.17.5 的 Fight 使用此现有模板。重命名节点不能依赖 baseTask
    # 继承 template：实际解析会回退到 ChatMAAReadyHome.png。
    patch["ChatMAAReadyHome"]["template"] = "SwitchTheme@ToggleSettingsMenu.png"
    (directory / "tasks.json").write_text(json.dumps(patch, indent=2), encoding="utf-8")
    return output / "readiness-policy"


def interpret_probe(events, task_id, stopped, failure=None):
    matches = []
    completed = False
    errors = []
    for event in events:
        detail = event.get("details") or {}
        if event.get("kind") != "callback" or detail.get("taskchain") != "Custom" or detail.get("taskid") != task_id:
            continue
        data = detail.get("details") or {}
        if event.get("message") == 20001 and data.get("task") in PROBE_NODES and data.get("action") == "Stop":
            expected = "MatchTemplate" if data["task"] == "ChatMAAReadyHome" else "OcrDetect"
            if data.get("algorithm") == expected:
                matches.append(data["task"])
        if event.get("message") == 10002:
            completed = True
        if event.get("message") in (10000, 20000):
            errors.append(event["message"])
    ready = bool(matches) and completed and stopped and not failure and not errors
    return {"ready": bool(ready), "observed_at": time.time(),
            "basis": matches[-1] if ready else "environment_unconfirmed"}


def fresh(evidence, now=None):
    age = (time.time() if now is None else now) - evidence.get("observed_at", 0)
    return evidence.get("ready") is True and 0 <= age <= READY_TTL_SECONDS

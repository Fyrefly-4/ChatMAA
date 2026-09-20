"""D2 操作执行：复用连接、停止及环境核对，分别解释扫描和刷图。"""
import json
import time

from connection import create_core, connect_core, target_identity
from contract import write_failure_overlay
from core import Core, ResourceLoadError
from fight_evidence import summarize_fight
from inventory import summarize_inventory
from native import Session, probe
from operations import core_task
from readiness import fresh
from evidence import uncertain


def projection(events, task_id, params, stopped=False):
    if params["kind"] == "scan_inventory":
        result = summarize_inventory(events, task_id, stopped)
    else:
        result = summarize_fight(events, task_id, params, stopped)
    connection_errors = {"ConnectFailed", "UnsupportedResolution", "ResolutionError", "Reconnecting",
                         "Disconnect", "ScreencapFailed", "TouchModeNotAvailable"}
    if any(e.get("kind") == "callback" and (e.get("message") in (0, 1) or
           (e.get("message") == 2 and (e.get("details") or {}).get("what") in connection_errors)) for e in events):
        result["errors"] = sorted(set(result["errors"]) | {"core_or_connection_error"})
        result.update(uncertain(result, "core_or_connection_error"))
    return result


def execute_operation(settings, operation, stop, emit, output, core_factory=Core):
    params = operation["params"]
    kind, mapped = core_task(params)
    if stop.is_set():
        result = projection([], 0, params, True)
        result.update(automation_stopped=True, reason="user_stop_before_start", evidence_source="MaaCore_v6.17.5",
                      environment={"ready": False, "observed_at": time.time(), "basis": "not_observed"})
        return result
    target = target_identity(settings)
    environment = probe(settings, stop, output / "before-check", core_factory, return_from_depot=True)
    result = projection([], 0, params)
    result.update(automation_stopped=environment["automation_stopped"], reason="environment_unconfirmed",
                  environment=environment, evidence_source="MaaCore_v6.17.5")
    if not fresh(environment) or stop.is_set():
        return result
    execution = output / "execution"
    execution.mkdir()
    try:
        core = create_core(settings, execution, core_factory, quiet_callbacks=True,
                           incremental=write_failure_overlay(execution) if kind == "Fight" else None)
    except ResourceLoadError as error:
        result.update(reason="resource_load_failed", environment={"ready": False, "observed_at": time.time(),
                      "basis": "resource_load_failed", "error": repr(error), "automation_stopped": True})
        return result
    session = Session(core)
    task_id, failure, reason = 0, None, "normal"
    try:
        if core.version != "v6.17.5":
            raise RuntimeError("unsupported MaaCore version")
        connect_core(core, settings)
        if not fresh(environment):
            raise RuntimeError("environment evidence expired before execution")
        if not stop.is_set():
            core.write("operation_summary", operation=params, params=mapped, target=target)
            task_id = core.lib.AsstAppendTask(core.handle, kind.encode(), json.dumps(mapped).encode())
            if task_id <= 0:
                raise RuntimeError("Core parameters rejected")
            if not stop.is_set():
                if not core.lib.AsstStart(core.handle):
                    raise RuntimeError("AsstStart rejected")
                emit("worker_started", {})
                while True:
                    with core.event_lock:
                        current = projection(list(core.events), task_id, params)
                    emit("operation_progress", current)
                    if current["errors"] or core.callback_error:
                        reason = "execution_or_evidence_error"
                        stop.set()
                    elif stop.is_set() and reason == "normal":
                        reason = "user_stop"
                    if stop.is_set():
                        session.stop()
                    if not session.running():
                        break
                    time.sleep(0.1)
        if stop.is_set() and reason == "normal":
            reason = "user_stop_before_start"
    except Exception as error:
        reason, failure = "runtime_error", repr(error)
    finally:
        session.close()
    result = projection(core.events, task_id, params, session.stopped)
    result.update(automation_stopped=session.stopped, operation_automation_stopped=session.stopped,
                  reason=reason, runtime_error=failure, callback_error=core.callback_error,
                  stop_error=session.stop_error, evidence_source="MaaCore_v6.17.5",
                  environment={"ready": False, "observed_at": time.time(), "basis": "environment_unconfirmed"})
    (execution / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    # Partial completion doesn't itself forbid checking the environment. Errors and cancellation do.
    if reason == "normal" and result["task_chain_completed"] and not result["errors"] and not (failure or core.callback_error or session.stop_error):
        try:
            result["environment"] = probe(settings, stop, output / "after-check", core_factory,
                                          return_from_depot=kind == "Depot")
        except Exception as error:
            result["environment"] = {"ready": False, "observed_at": time.time(), "basis": "recognition_failed",
                                     "error": repr(error), "automation_stopped": False}
        result["automation_stopped"] = session.stopped and result["environment"]["automation_stopped"]
    return result

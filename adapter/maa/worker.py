"""工作线程不访问执行库；回调通过 inbox 交给控制层持久化。"""
import json
import hashlib
import os
from pathlib import Path
import time


def recheck(settings, execution_id, recheck_id, stop, emit):
    """只识别当前环境，不执行 Fight，不重跑旧任务。"""
    stopped = True
    try:
        directory = hashlib.sha256((execution_id + "\0" + recheck_id).encode("utf-8")).hexdigest()
        output = settings.data / "rechecks" / directory
        if settings.mode == "maa-live":
            from native import probe
            from connection import target_identity
            target_identity(settings)
            stopped = False
            environment = probe(settings, stop, output)
            stopped = environment["automation_stopped"]
        else:
            output.mkdir(parents=True)
            environment = {"ready": not stop.is_set(), "observed_at": time.time(), "basis": "offline_recheck"}
            (output / "result.json").write_text(json.dumps(environment), encoding="utf-8")
        (output / "request.json").write_text(json.dumps({"execution_id": execution_id, "recheck_id": recheck_id}), encoding="utf-8")
        emit("recheck_finished", {"environment": environment, "automation_stopped": stopped})
    except BaseException as error:
        emit("recheck_finished", {"environment": {"ready": False}, "automation_stopped": stopped, "error": repr(error)})


def execute(settings, operation, stop, emit):
    try:
        # Stable, case-sensitive identity without Windows reserved-name/path collisions.
        directory = hashlib.sha256(operation["id"].encode("utf-8")).hexdigest()
        output = settings.data / "operations" / directory
        output.mkdir(parents=True)  # Existing evidence must never be overwritten/re-executed.
        with (settings.data / "worker-audit.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({"id": operation["id"], "mode": settings.mode, "at": time.time()}) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        (output / "request.json").write_text(json.dumps(operation), encoding="utf-8")
        version_two = operation["params"].get("version") == 2
        if version_two and settings.mode == "maa-replay":
            from operation_replay import replay_operation
            result = replay_operation(operation, stop, emit, output)
        elif version_two:
            from resources import manifest, verify_material
            from execution import execute_operation, projection
            platform = "mumu" if settings.connection else "desktop"
            try:
                resources = manifest(settings.installation, platform)
                (output / "resources.json").write_text(json.dumps(resources, ensure_ascii=False, indent=2), encoding="utf-8")
                verify_material(settings.installation, platform, operation["params"])
            except (ValueError, OSError) as error:
                result = projection([], 0, operation["params"], True)
                result.update(automation_stopped=True, reason="resource_validation_failed", runtime_error=repr(error),
                              environment={"ready": False, "observed_at": time.time(), "basis": "resource_validation_failed"})
            else:
                result = execute_operation(settings, operation, stop, emit, output)
                result["resource_digest"] = resources["sha256"]
        elif settings.mode == "maa-replay":
            from replay import replay
            result = replay(operation, stop, emit, output)
        else:
            from native import execute_native
            result = execute_native(settings, operation, stop, emit, output)
        (output / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        emit("operation_finished" if version_two else "finished", result)
    except BaseException as error:
        emit("worker_error", {"error": repr(error)})

"""工作线程不访问执行库；回调通过 inbox 交给控制层持久化。"""
import json
import hashlib
import os
from pathlib import Path
import time


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
        if settings.mode == "maa-replay":
            from replay import replay
            result = replay(operation, stop, emit, output)
        else:
            from native import execute_native
            result = execute_native(settings, operation, stop, emit, output)
        (output / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        emit("finished", result)
    except BaseException as error:
        emit("worker_error", {"error": repr(error)})

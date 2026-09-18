"""真实主界面识别门槛。只执行 Custom 的 Stop 节点，不点击按钮或进入战斗。"""
import argparse
import json
import msvcrt
import os
from pathlib import Path
import signal
import threading
import time

from core import Core, window_identity
from contract import write_home_probe_overlay


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--installation", type=Path, required=True)
    parser.add_argument("--hwnd", type=int, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    window_identity(args.hwnd)
    root = Path(__file__).resolve().parent / ".artifacts"
    output = args.output.resolve()
    output.relative_to(root)
    with (root / "device.lock").open("a+b") as lock:
        if os.fstat(lock.fileno()).st_size == 0:
            lock.write(b"0"); lock.flush()
        lock.seek(0)
        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        output.mkdir()
        canceled = threading.Event()
        signal.signal(signal.SIGINT, lambda *_: canceled.set())
        signal.signal(signal.SIGTERM, lambda *_: canceled.set())
        core = Core(args.installation, output, incremental=write_home_probe_overlay(output), quiet_callbacks=True)
        failure = None
        task_id = 0
        try:
            if core.version != "v6.17.5":
                raise RuntimeError("Core 版本变化，需要重新核对")
            core.attach(args.hwnd)
            if canceled.is_set():
                raise RuntimeError("用户取消")
            task_id = core.lib.AsstAppendTask(core.handle, b"Custom", b'{"task_names":["Fight"]}')
            if task_id <= 0 or not core.lib.AsstStart(core.handle):
                raise RuntimeError("Custom 识别任务未受理")
            core.write("recognition_probe_started", task_id=task_id, battle_started=False)
            begin = time.monotonic()
            while core.lib.AsstRunning(core.handle):
                if canceled.is_set() or core.callback_error or time.monotonic() - begin > 15:
                    raise RuntimeError("识别取消、记录异常或超时")
                time.sleep(0.05)
            core.write("automation_not_running")
        except Exception as error:
            failure = repr(error)
        finally:
            if core.lib.AsstRunning(core.handle):
                stopper = threading.Thread(target=lambda: core.lib.AsstStop(core.handle))
                stopper.start()
                stopper.join(10)
                if stopper.is_alive():
                    print("停止尚未确认，请回到 Codex 交接，不启动战斗。", flush=True)
                stopper.join()
                while core.lib.AsstRunning(core.handle):
                    time.sleep(0.05)
            core.close()
        matches = []
        completed = False
        errors = []
        for event in core.events:
            if event.get("kind") != "callback":
                continue
            detail = event.get("details") or {}
            if detail.get("taskid") != task_id or detail.get("taskchain") != "Custom":
                continue
            data = detail.get("details") or {}
            if event["message"] == 20001 and data.get("task") == "Fight" and data.get("action") == "Stop" and data.get("algorithm") == "MatchTemplate":
                matches.append(data.get("result"))
            if event["message"] == 10002:
                completed = True
            if event["message"] in (10000, 20000):
                errors.append(event["message"])
        passed = bool(matches) and completed and not (failure or errors or core.callback_error or canceled.is_set())
        result = {"home_recognized": passed, "matches": matches, "task_chain_completed": completed,
                  "errors": errors, "runtime_error": failure, "callback_error": core.callback_error,
                  "battle_started": False, "automation_stopped": True, "destroy_returned": True}
        (output / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(result, ensure_ascii=False), flush=True)
        return 0 if passed else 2


if __name__ == "__main__":
    raise SystemExit(main())

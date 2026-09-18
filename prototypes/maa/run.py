"""单轮真实执行。重复使用同一输出目录拒绝执行；不自动补刷。"""
import argparse
import contextlib
import hashlib
import json
import msvcrt
import os
from pathlib import Path
import signal
import threading
import time

from core import Core, window_identity
from contract import fight_params, write_failure_overlay, summarize


def main(argv=None, *, stop_requested=None, on_progress=None, device_lock_held=False):
    parser = argparse.ArgumentParser()
    parser.add_argument("--installation", type=Path, required=True)
    parser.add_argument("--hwnd", type=int, required=True)
    parser.add_argument("--count", type=int, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-seconds", type=int, default=1200)
    parser.add_argument("--continues", choices=["verified-three"])
    args = parser.parse_args(argv)
    params = fight_params(args.count)
    identity = window_identity(args.hwnd)
    root = Path(__file__).resolve().parent
    artifacts = root / ".artifacts"
    artifacts.mkdir(exist_ok=True)
    output = args.output.resolve()
    output.relative_to(artifacts)  # 本原型只向自身运行产物目录写入。
    # HTTP 执行端在启动时持有同一路径的锁；CLI 仍自己取得锁。
    with contextlib.nullcontext() if device_lock_held else (artifacts / "device.lock").open("a+b") as lock:
        if not device_lock_held:
            if os.fstat(lock.fileno()).st_size == 0:
                lock.write(b"0"); lock.flush()
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        output.mkdir()  # 一轮操作只可启动一次；已有目录必须先人工核对，不能重放。
        policy = write_failure_overlay(output)
        manifest = {"created_at": time.time(), "pid": os.getpid(), "window": identity,
                    "continues": args.continues,
                    "params": params, "core_sha256": hashlib.file_digest((args.installation / "MaaCore.dll").open("rb"), "sha256").hexdigest(),
                    "failure_policy": "private Fight-prefixed Stop overrides", "state": "preparing"}
        (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        (artifacts / "live-run.json").write_text(json.dumps({"pid": os.getpid(), "output": str(output)}), encoding="utf-8")
        stop_requested = stop_requested if stop_requested is not None else threading.Event()
        stop_returned = threading.Event()
        if threading.current_thread() is threading.main_thread():
            signal.signal(signal.SIGINT, lambda *_: stop_requested.set())
            signal.signal(signal.SIGTERM, lambda *_: stop_requested.set())
        core = Core(args.installation, output, incremental=policy, quiet_callbacks=True)
        task_id = 0
        started = False
        stop_thread = None
        reason = "normal"
        runtime_error = None
        stop_error = None
        stop_sent_at = None
        not_running_observed = False
        destroyed = False

        def record(kind, **values):
            try:
                core.write(kind, **values)
            except Exception as error:
                core.callback_error = repr(error)

        def request_stop():
            nonlocal stop_thread, stop_error, stop_sent_at
            if stop_thread is not None:
                return
            record("stop_requested", reason=reason)
            stop_sent_at = time.monotonic()

            def deliver_stop():
                nonlocal stop_error
                try:
                    returned = bool(core.lib.AsstStop(core.handle))
                    record("stop_returned", accepted=returned)
                    if not returned:
                        stop_error = "AsstStop rejected"
                except Exception as error:
                    stop_error = repr(error)
                    record("stop_error", error=stop_error)
                finally:
                    stop_returned.set()

            stop_thread = threading.Thread(target=deliver_stop)
            stop_thread.start()

        def user_wants_stop():
            return stop_requested.is_set() or (output / "stop.request").exists()

        try:
            if core.version != "v6.17.5":
                raise RuntimeError("该实验只核对过 v6.17.5，请先重新审阅版本")
            core.attach(args.hwnd)
            core.screenshot("before.png")
            if user_wants_stop():
                reason = "user_stop_before_start"
                return
            core.write("operation_summary", params=params, failure_policy=str(policy.relative_to(output)))
            task_id = core.lib.AsstAppendTask(core.handle, b"Fight", json.dumps(params).encode("utf-8"))
            core.write("task_appended", task_id=task_id)
            if task_id <= 0:
                raise RuntimeError("Fight parameters rejected")
            if user_wants_stop():
                reason = "user_stop_before_start"
                return
            started = bool(core.lib.AsstStart(core.handle))
            core.write("start_returned", accepted=started)
            if not started:
                raise RuntimeError("AsstStart rejected")
            manifest.update(state="running", task_id=task_id, core_version=core.version)
            (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
            begin = time.monotonic()
            last_count = -1
            stop_pending_reported = False
            while True:
                with core.event_lock:
                    projection = summarize(list(core.events), task_id, args.count)
                if on_progress is not None:
                    on_progress(projection)
                if projection["observed_successes"] != last_count:
                    last_count = projection["observed_successes"]
                    core.write("observed_progress", count=last_count, requested=args.count)
                if user_wants_stop() and reason == "normal":
                    reason = "user_stop"
                    stop_requested.set()
                if projection["errors"] or projection["count_unknown"] or core.callback_error:
                    reason = "execution_or_evidence_error"
                    stop_requested.set()
                if time.monotonic() - begin > args.max_seconds:
                    reason = "experiment_time_limit"
                    stop_requested.set()
                if stop_requested.is_set() and stop_thread is None:
                    request_stop()
                if stop_sent_at is not None and not stop_pending_reported and time.monotonic() - stop_sent_at > 10:
                    record("stop_pending", instruction="尚未确认停止，请回到 Codex 交接；不要重复运行。")
                    stop_pending_reported = True
                running = bool(core.lib.AsstRunning(core.handle))
                if not running and (stop_thread is None or stop_returned.is_set()):
                    not_running_observed = True
                    record("automation_not_running", reason=reason)
                    break
                time.sleep(0.1)
            if stop_thread:
                stop_thread.join()
            time.sleep(0.3)  # 等待异步消息队列收尾；Destroy 后再形成最终解释。
            core.screenshot("after.png")
        except Exception as error:
            runtime_error = repr(error)
            reason = "runtime_error"
            record("runtime_error", error=runtime_error)
        finally:
            # 异常路径也先停再销毁。普通停止未确认时不强杀；关闭终端仍可能留下未知。
            if bool(core.lib.AsstRunning(core.handle)):
                request_stop()
            pending_since = time.monotonic()
            pending_reported = False
            while bool(core.lib.AsstRunning(core.handle)) or (stop_thread is not None and not stop_returned.is_set()):
                if not pending_reported and time.monotonic() - pending_since > 10:
                    record("stop_pending", instruction="尚未确认停止，请回到 Codex 交接；不要重复运行。")
                    pending_reported = True
                time.sleep(0.1)
            if not not_running_observed:
                not_running_observed = True
                record("automation_not_running", reason=reason)
            if stop_thread:
                stop_thread.join()
            core.close()
            destroyed = True
            with core.event_lock:
                result = summarize(list(core.events), task_id, args.count)
            result.update(reason=reason, start_accepted=started, callback_error=core.callback_error,
                          runtime_error=runtime_error, stop_error=stop_error,
                          asst_running_false_observed=not_running_observed, destroy_returned=destroyed,
                          automation_stopped=not_running_observed and destroyed, finished_at=time.time())
            (output / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
            manifest["state"] = "ended"
            (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
            print(json.dumps({"kind": "result", **result}, ensure_ascii=False), flush=True)
        if runtime_error or stop_error or core.callback_error:
            return 1
        return 0 if result["matches_requested_evidence"] else 2


if __name__ == "__main__":
    raise SystemExit(main())

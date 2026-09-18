"""固定 Windows MaaCore 的单次操作；只在显式 live 提交后调用。"""
import json
from pathlib import Path
import threading
import time

from contract import fight_params, summarize, write_failure_overlay
from core import Core, ResourceLoadError, window_identity
from readiness import fresh, interpret_probe, write_readiness_overlay


class Session:
    """普通停止只发 AsstStop；未确认时留在工作线程，不升级为杀进程。"""
    def __init__(self, core):
        self.core = core
        self.stopper = None
        self.stop_error = None
        self.stopped = False

    def stop(self):
        if self.stopper:
            return

        def deliver():
            try:
                if not self.core.lib.AsstStop(self.core.handle):
                    self.stop_error = "AsstStop rejected"
            except BaseException as error:
                self.stop_error = repr(error)

        self.stopper = threading.Thread(target=deliver, daemon=True)
        self.stopper.start()

    def running(self):
        running = bool(self.core.lib.AsstRunning(self.core.handle))
        return running or bool(self.stopper and self.stopper.is_alive())

    def close(self):
        if self.running():
            self.stop()
        while self.running():
            time.sleep(0.05)
        if self.stopper:
            self.stopper.join()
        self.core.write("automation_not_running")
        self.core.close()
        self.stopped = True


def probe(settings, stop, output, core_factory=Core):
    output.mkdir(parents=True)
    try:
        core = core_factory(settings.installation, output, incremental=write_readiness_overlay(output), quiet_callbacks=True)
    except ResourceLoadError as error:
        evidence = {"ready": False, "observed_at": time.time(), "basis": "resource_load_failed",
                    "automation_stopped": True, "error": repr(error)}
        (output / "result.json").write_text(json.dumps(evidence, indent=2), encoding="utf-8")
        return evidence
    session = Session(core)
    task_id = 0
    failure = None
    try:
        if core.version != "v6.17.5":
            raise RuntimeError("unsupported MaaCore version")
        core.attach(settings.hwnd)
        if stop.is_set():
            raise RuntimeError("canceled before recognition")
        task_id = core.lib.AsstAppendTask(core.handle, b"Custom",
                                        b'{"task_names":["ChatMAAReadyHome","ChatMAAReadyStage"]}')
        if task_id <= 0 or not core.lib.AsstStart(core.handle):
            raise RuntimeError("recognition not accepted")
        deadline = time.monotonic() + 15
        while session.running():
            if stop.is_set() or core.callback_error or time.monotonic() > deadline:
                failure = "recognition canceled, timed out or evidence failed"
                session.stop()
            time.sleep(0.05)
    except Exception as error:
        failure = repr(error)
    finally:
        try:
            session.close()
        except Exception as error:
            failure = repr(error)
    evidence = interpret_probe(core.events, task_id, session.stopped,
                               failure or session.stop_error or core.callback_error or stop.is_set())
    evidence.update(automation_stopped=session.stopped,
                    error=failure or session.stop_error or core.callback_error)
    (output / "result.json").write_text(json.dumps(evidence, indent=2), encoding="utf-8")
    return evidence


def execute_native(settings, operation, stop, emit, output, core_factory=Core, identity=window_identity):
    count = operation["params"]["count"]
    params = fight_params(count)
    window = identity(settings.hwnd)
    environment = probe(settings, stop, output / "before-check", core_factory)
    result = summarize([], 0, count)
    result.update(automation_stopped=environment["automation_stopped"], reason="environment_unconfirmed", environment=environment,
                  evidence_source="MaaCore_v6.17.5")
    if not fresh(environment) or stop.is_set():
        return result
    battle = output / "battle"
    battle.mkdir()
    core = core_factory(settings.installation, battle, incremental=write_failure_overlay(battle), quiet_callbacks=True)
    session = Session(core)
    task_id = 0
    reason = "normal"
    failure = None
    try:
        if core.version != "v6.17.5":
            raise RuntimeError("unsupported MaaCore version")
        core.attach(settings.hwnd)
        if not fresh(environment):
            raise RuntimeError("environment evidence expired before execution")
        if stop.is_set():
            reason = "user_stop_before_start"
        else:
            core.write("operation_summary", params=params, window=window)
            task_id = core.lib.AsstAppendTask(core.handle, b"Fight", json.dumps(params).encode("utf-8"))
            if task_id <= 0:
                raise RuntimeError("Fight parameters rejected")
            if stop.is_set():
                reason = "user_stop_before_start"
            else:
                if not core.lib.AsstStart(core.handle):
                    raise RuntimeError("AsstStart rejected")
                emit("worker_started", {})
                while True:
                    with core.event_lock:
                        projection = summarize(list(core.events), task_id, count)
                    emit("progress", projection)
                    if projection["errors"] or projection["count_unknown"] or core.callback_error:
                        reason = "execution_or_evidence_error"
                        stop.set()
                    elif stop.is_set() and reason == "normal":
                        reason = "user_stop"
                    if stop.is_set():
                        session.stop()
                    if not session.running():
                        break
                    time.sleep(0.1)
    except Exception as error:
        reason, failure = "runtime_error", repr(error)
    finally:
        session.close()
    result = summarize(core.events, task_id, count)
    result.update(automation_stopped=session.stopped, reason=reason, runtime_error=failure,
                  battle_automation_stopped=session.stopped,
                  callback_error=core.callback_error, stop_error=session.stop_error,
                  evidence_source="MaaCore_v6.17.5", environment={"ready": False, "observed_at": time.time(),
                                                                              "basis": "environment_unconfirmed"})
    # Preserve battle evidence before starting the independent readiness phase.
    (battle / "result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    # A normal completion alone is not a readiness proof. Recognize the current screen separately.
    if reason == "normal" and result["matches_requested_evidence"] and not (failure or core.callback_error or session.stop_error):
        try:
            result["environment"] = probe(settings, stop, output / "after-check", core_factory)
        except Exception as error:
            # An unclassified failure cannot prove that recognition automation stopped.
            result["environment"] = {"ready": False, "observed_at": time.time(),
                                     "basis": "recognition_failed", "error": repr(error),
                                     "automation_stopped": False}
        result["automation_stopped"] = session.stopped and result["environment"]["automation_stopped"]
    return result

import copy
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from contract import fight_params, MAX_COUNT, summarize
from core import ResourceLoadError
from native import execute_native
from readiness import fresh, interpret_probe, write_readiness_overlay
from service import Controller, Submission, RecheckRequest
from settings import Settings, DeviceLocks

FIXTURE = json.loads((Path(__file__).resolve().parents[1] / "fixtures/verified-first-battle.json").read_text(encoding="utf-8"))["events"]


def request(count=10, identity="op"):
    return Submission(id=identity, params={"stage": "1-7", "count": count, "medicine": 0, "premium": 0})


class NativeHarness:
    """Only substitutes the public MaaCore boundary; native.py runs unchanged."""
    def __init__(self, stop=None, ready=True, screen="stage"):
        self.calls = []
        self.stop_event = stop
        self.ready = ready
        self.screen = screen
        self.active_cores = 0

    def core(self, installation, output, **kwargs):
        parent = self

        class FakeCore:
            def __init__(self):
                self.version = "v6.17.5"
                self.events = []
                self.event_lock = threading.Lock()
                self.callback_error = None
                self.handle = 1
                self.lib = self
                self.running = False
                self.kind = None
                parent.active_cores += 1

            def attach(self, hwnd):
                parent.calls.append(("attach", hwnd))

            def write(self, kind, **values):
                parent.calls.append((kind, values))

            def AsstAppendTask(self, handle, kind, raw):
                self.kind, self.params = kind.decode(), json.loads(raw)
                parent.calls.append((self.kind, self.params))
                return 1

            def AsstStart(self, handle):
                if self.kind == "Custom":
                    matches = parent.ready
                    node, algorithm = "ChatMAAReadyStage", "OcrDetect"
                    if parent.screen == "home":
                        node, algorithm = "ChatMAAReadyHome", "MatchTemplate"
                        policy = json.loads((Path(kwargs["incremental"]) / "resource/tasks/tasks.json").read_text(encoding="utf-8"))
                        # Actual failed run: renamed tasks defaulted to their own PNG name.
                        template = policy[node].get("template", node + ".png")
                        matches = matches and template == "SwitchTheme@ToggleSettingsMenu.png"
                    if matches:
                        self.events = [{"kind": "callback", "message": 20001,
                                        "details": {"taskchain": "Custom", "taskid": 1,
                                                    "details": {"task": node, "action": "Stop", "algorithm": algorithm}}},
                                       {"kind": "callback", "message": 10002, "details": {"taskchain": "Custom", "taskid": 1}}]
                else:
                    for cycle in range(1, (1 if parent.stop_event else self.params["times"]) + 1):
                        events = copy.deepcopy(FIXTURE)
                        for event in events:
                            data = event["details"].get("details", {})
                            if "exec_times" in data:
                                data["exec_times"] = cycle
                        self.events += events
                    if parent.stop_event:
                        self.running = True
                        parent.stop_event.set()
                    else:
                        self.events.append({"kind": "callback", "at": 0, "message": 10002,
                                            "details": {"taskchain": "Fight", "taskid": 1}})
                return True

            def AsstRunning(self, handle):
                return self.running

            def AsstStop(self, handle):
                parent.calls.append(("stop", self.kind))
                self.running = False
                return True

            def close(self):
                if self.running:
                    raise AssertionError("destroy while automation still running")
                parent.active_cores -= 1
                parent.calls.append(("destroy", self.kind))

        return FakeCore()


class ExecutionTest(unittest.TestCase):
    def test_live_configuration_accepts_wizard_runs_and_keeps_one_device_lock(self):
        from settings import REPOSITORY, CORE_SHA256
        with tempfile.TemporaryDirectory() as tmp:
            installation = Path(tmp)
            (installation / "MaaCore.dll").write_bytes(b"configuration fixture")
            raw = {"mode": "maa-live", "controller": "test", "token": "test", "installation": tmp, "hwnd": 1}
            locks = []
            for path in [REPOSITORY / ".artifacts/live", REPOSITORY / ".artifacts/live-wizard/run-config-test/data"]:
                raw["data"] = str(path)
                with patch.dict(os.environ, CHATMAA_ADAPTER_CONFIG=json.dumps(raw)), patch("settings.sys.platform", "win32"), patch("settings.hashlib.file_digest") as digest:
                    digest.return_value.hexdigest.return_value = CORE_SHA256
                    settings = Settings.from_env()
                    self.assertEqual(settings.data, path.resolve())
                    locks.append(settings.lock_paths())
            self.assertEqual(locks[0], locks[1])
            raw["data"] = str(REPOSITORY / ".artifacts/live-wizard/other/data")
            with patch.dict(os.environ, CHATMAA_ADAPTER_CONFIG=json.dumps(raw)):
                with self.assertRaises(ValueError): Settings.from_env()

    def test_resource_reload_across_two_independent_operations(self):
        # Model the observed loader boundary: definitions survive reload and an
        # implicit template falls back to the prefixed node's nonexistent PNG.
        with tempfile.TemporaryDirectory() as tmp:
            settings = Settings("maa-live", Path(tmp), "controller", "token", installation=Path(tmp), hwnd=1)
            for broken in [True, False]:
                retained = {}
                harness = NativeHarness(screen="home")
                def factory(installation, output, **kwargs):
                    for name, node in retained.items():
                        if node.get("algorithm", "MatchTemplate") == "MatchTemplate":
                            if node.get("template", name + ".png") not in {"AbandonAction.png", "PrtsErrorConfirm.png"}:
                                raise ResourceLoadError("missing prefixed template")
                    policy = json.loads((kwargs["incremental"] / "resource/tasks/tasks.json").read_text())
                    for name, node in policy.items():
                        if name.startswith("Fight@"):
                            retained[name] = {"action": "Stop"} if broken else node
                    return harness.core(installation, output, **kwargs)
                for index in range(2):
                    output = Path(tmp) / f"{broken}-{index}"
                    output.mkdir()
                    result = execute_native(settings, request(count=1, identity=str(index)).model_dump(),
                                            threading.Event(), lambda *a: None, output, factory, lambda hwnd: {})
                    self.assertEqual(result["environment"]["ready"], not broken)
                    if not broken:
                        self.assertEqual(result["observed_successes"], 1)
                self.assertEqual(sum(k == "Fight" for k, _ in harness.calls), 1 if broken else 2)

    def test_postcheck_failure_preserves_battle_evidence_and_blocks_next_task(self):
        for load_failure in [True, False]:
            with self.subTest(load_failure=load_failure), tempfile.TemporaryDirectory() as tmp:
                settings = Settings("maa-live", Path(tmp), "controller", "token", installation=Path(tmp), hwnd=1)
                harness = NativeHarness()
                def factory(installation, output, **kwargs):
                    if output.name == "after-check":
                        if load_failure:
                            raise ResourceLoadError("resource unavailable: D:/private-installation/resource")
                        core = harness.core(installation, output, **kwargs)
                        core.close = lambda: (_ for _ in ()).throw(RuntimeError("destroy unconfirmed"))
                        return core
                    return harness.core(installation, output, **kwargs)
                result = execute_native(settings, request(count=1).model_dump(), threading.Event(), lambda *a: None,
                                        Path(tmp), factory, lambda hwnd: {})
                self.assertEqual(result["observed_successes"], 1)
                self.assertTrue(result["battle_automation_stopped"])
                self.assertEqual(result["automation_stopped"], load_failure)
                self.assertFalse(result["environment"]["ready"])
                self.assertTrue(result["environment"]["error"])
                saved = json.loads((Path(tmp) / "battle/result.json").read_text())
                self.assertEqual(saved["observed_successes"], 1)
                control = Controller(settings, worker=lambda *a: None)
                control.submit(request(count=1))
                control.inbox.put(("op", "finished", result)); control.drain()
                view = control.read("op")
                self.assertEqual(view["confirmed"], 1)
                self.assertEqual(view["certainty"], "exact")
                self.assertEqual(view["state"], "ended" if load_failure else "unknown")
                self.assertEqual(view["device"], "needs_check")
                self.assertEqual(view["environment"]["error"], "environment_check_failed")
                self.assertNotIn("private-installation", json.dumps(view))
                final_event = control.query("op")["events"][-1]
                self.assertEqual(final_event["detail"]["environment"]["error"], result["environment"]["error"])
                with self.assertRaises(Exception): control.submit(request(identity="blocked"))
                control.db.close()

    def test_home_probe_uses_existing_resource_and_missing_template_prevents_fight(self):
        def missing_template(output):
            root = write_readiness_overlay(output)
            file = root / "resource/tasks/tasks.json"
            patch_data = json.loads(file.read_text(encoding="utf-8"))
            patch_data["ChatMAAReadyHome"].pop("template", None)
            file.write_text(json.dumps(patch_data), encoding="utf-8")
            return root

        for missing in [False, True]:
            with self.subTest(missing=missing), tempfile.TemporaryDirectory() as tmp:
                settings = Settings("maa-live", Path(tmp), "controller", "token", installation=Path(tmp), hwnd=1)
                harness = NativeHarness(screen="home")
                with patch("native.write_readiness_overlay", side_effect=missing_template if missing else write_readiness_overlay):
                    result = execute_native(settings, request(count=1).model_dump(), threading.Event(), lambda *args: None,
                                            Path(tmp), harness.core, lambda hwnd: {"hwnd": hwnd})
                self.assertEqual(result["environment"]["ready"], not missing)
                self.assertEqual(any(kind == "Fight" for kind, _ in harness.calls), not missing)
                if not missing:
                    self.assertEqual(result["environment"]["basis"], "ChatMAAReadyHome")
                    self.assertEqual(result["observed_successes"], 1)

    def test_recheck_only_recognizes_and_preserves_old_outcome(self):
        from native import probe
        with tempfile.TemporaryDirectory() as tmp:
            settings = Settings("maa-live", Path(tmp), "controller", "token", installation=Path(tmp), hwnd=1)
            control = Controller(settings, worker=lambda *args: None)
            control.submit(request(identity="old"))
            control.active.clear()
            control.record("old", "test_finished", state="ended", automation_stopped=True, device="needs_check",
                           reason="environment_unconfirmed", environment={"ready": False})
            original = control.read("old")
            harness = NativeHarness()
            with patch("core.window_identity", return_value={}), patch("native.probe", side_effect=lambda s, stop, output: probe(s, stop, output, harness.core)):
                control.recheck("old", RecheckRequest(id="check-1"))
                with self.assertRaises(Exception):
                    control.submit(request(identity="too-early"))
                deadline = time.monotonic() + 3
                while control.active and time.monotonic() < deadline:
                    time.sleep(0.01)
                    control.drain()
            result = control.read("old")
            self.assertEqual(result["device"], "ready")
            self.assertTrue(result["recheck"]["automation_stopped"])
            for field in ["state", "confirmed", "certainty", "reason", "environment", "started_cycles", "unsettled_cycles"]:
                self.assertEqual(result[field], original[field])
            self.assertTrue(any(kind == "Custom" for kind, _ in harness.calls))
            self.assertFalse(any(kind == "Fight" for kind, _ in harness.calls))
            control.db.close()
            recovered = Controller(settings, worker=lambda *a: None, recheck_worker=lambda *a: self.fail("duplicate probe"))
            recovered.recheck("old", RecheckRequest(id="check-1"))
            self.assertFalse(recovered.active)
            recovered.submit(request(identity="new"))
            self.assertIn("new", recovered.active)
            recovered.db.close()

    def test_failed_canceled_and_interrupted_rechecks_do_not_unlock(self):
        for cancel in [False, True]:
            with tempfile.TemporaryDirectory() as tmp:
                settings = Settings("maa-replay", Path(tmp), "controller", "token")
                control = Controller(settings, worker=lambda *a: None, recheck_worker=lambda *a: None)
                control.submit(request(identity="old")); control.active.clear()
                control.record("old", "test_finished", state="ended", automation_stopped=True, device="needs_check")
                control.recheck("old", RecheckRequest(id="check"))
                if cancel:
                    control.request_stop("old")
                raw_error = "resource unavailable: D:/private-installation/resource"
                control.inbox.put(("old", "recheck_finished", {"environment": {"ready": cancel, "observed_at": time.time(), "error": raw_error}, "automation_stopped": True}))
                control.drain()
                self.assertEqual(control.read("old")["device"], "needs_check")
                self.assertEqual(control.read("old")["recheck"]["environment"]["error"], "environment_check_failed")
                self.assertNotIn("private-installation", json.dumps(control.read("old")))
                self.assertEqual(control.query("old")["events"][-1]["detail"]["environment"]["error"], raw_error)
                with self.assertRaises(Exception): control.submit(request(identity="blocked"))
                control.recheck("old", RecheckRequest(id="interrupted"))
                control.db.close()
                recovered = Controller(settings, worker=lambda *a: None)
                self.assertEqual(recovered.read("old")["recheck"]["state"], "unknown")
                with self.assertRaises(Exception): recovered.recheck("old", RecheckRequest(id="no-bypass"))
                recovered.db.close()

    def test_parameters_and_evidence(self):
        for count in [0, -1, True, "10", 1.2, MAX_COUNT + 1]:
            with self.assertRaises(ValueError):
                fight_params(count)
            with self.assertRaises(ValueError):
                request(count)
        self.assertEqual(fight_params(10)["times"], 10)
        self.assertEqual(fight_params(MAX_COUNT)["times"], MAX_COUNT)
        self.assertEqual(summarize(FIXTURE + FIXTURE, 1, 10)["observed_successes"], 1)
        self.assertEqual(summarize(FIXTURE, 2, 10)["observed_successes"], 0)
        incomplete = [e for e in FIXTURE if e["details"].get("what") != "FightTimes"]
        self.assertTrue(summarize(incomplete, 1, 10)["count_unknown"])
        self.assertFalse(summarize([{"kind": "callback", "message": 10002,
                                     "details": {"taskchain": "Fight", "taskid": 1}}], 1, 10)["matches_requested_evidence"])

    def test_recognition_is_not_navigation_and_requires_current_matching_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            policy = write_readiness_overlay(Path(tmp))
            for node in json.loads((policy / "resource/tasks/tasks.json").read_text()).values():
                self.assertEqual(node["action"], "Stop")
                for name in ["sub", "next", "onErrorNext", "exceededNext", "reduceOtherTimes"]:
                    self.assertEqual(node[name], [])
        self.assertFalse(interpret_probe([], 1, True)["ready"])
        self.assertFalse(fresh({"ready": True, "observed_at": 5}, now=11))
        self.assertFalse(fresh({"ready": True, "observed_at": 12}, now=11))
        self.assertTrue(fresh({"ready": True, "observed_at": 10}, now=11))

    def test_live_path_parameter_mapping_normal_result_and_separate_readiness(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings = Settings("maa-live", Path(tmp), "controller", "token", installation=Path(tmp), hwnd=1)
            harness = NativeHarness()
            result = execute_native(settings, request().model_dump(), threading.Event(), lambda *args: None,
                                    Path(tmp), harness.core, lambda hwnd: {"hwnd": hwnd})
            fight = next(value for kind, value in harness.calls if kind == "Fight")
            self.assertEqual(fight["times"], 10)
            self.assertEqual([fight[k] for k in ("medicine", "medicine_expire_days", "stone")], [0, 0, 0])
            self.assertEqual(fight["series"], 1)
            self.assertEqual(result["observed_successes"], 10)
            self.assertTrue(result["automation_stopped"])
            self.assertTrue(result["environment"]["ready"])
            self.assertEqual(harness.active_cores, 0)
            self.assertEqual(sum(kind == "Custom" for kind, _ in harness.calls), 2)

    def test_unknown_environment_never_starts_fight(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings = Settings("maa-live", Path(tmp), "controller", "token", installation=Path(tmp), hwnd=1)
            harness = NativeHarness(ready=False)
            result = execute_native(settings, request().model_dump(), threading.Event(), lambda *args: None,
                                    Path(tmp), harness.core, lambda hwnd: {"hwnd": hwnd})
            self.assertFalse(any(kind == "Fight" for kind, _ in harness.calls))
            self.assertFalse(result["environment"]["ready"])
            self.assertEqual(result["observed_successes"], 0)

    def test_native_stop_is_delivered_and_does_not_invent_completion(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings = Settings("maa-live", Path(tmp), "controller", "token", installation=Path(tmp), hwnd=1)
            stop = threading.Event()
            harness = NativeHarness(stop=stop)
            result = execute_native(settings, request().model_dump(), stop, lambda *args: None,
                                    Path(tmp), harness.core, lambda hwnd: {"hwnd": hwnd})
            self.assertIn(("stop", "Fight"), harness.calls)
            self.assertTrue(result["automation_stopped"])
            self.assertFalse(result["matches_requested_evidence"])
            self.assertEqual(result["observed_successes"], 1)
            self.assertFalse(result["environment"]["ready"])
            self.assertEqual(harness.active_cores, 0)

    def test_controller_storage_failure_still_signals_worker_and_restart_is_uncertain(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings = Settings("maa-replay", Path(tmp), "controller", "token")
            control = Controller(settings, worker=lambda *args: None)
            try:
                control.submit(request())
                stop = control.active["op"]["stop"]
                control.db.execute("PRAGMA query_only=ON")
                control.request_stop("op")
                self.assertTrue(stop.is_set())
                self.assertTrue(control.storage_failed)
                self.assertEqual(control.query("op")["snapshot"]["state"], "unknown")
            finally:
                control.db.close()
            recovered = Controller(settings, worker=lambda *args: self.fail("must not restart worker"))
            try:
                self.assertEqual(recovered.read("op")["state"], "unknown")
                with self.assertRaises(Exception):
                    recovered.submit(request(identity="new"))
            finally:
                recovered.db.close()

    def test_device_lock_is_exclusive(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "device.lock"
            first = DeviceLocks([path])
            try:
                with self.assertRaises(OSError):
                    DeviceLocks([path])
            finally:
                first.close()
            second = DeviceLocks([path])
            second.close()

    def test_formal_and_preserved_cli_share_a_lock_without_loading_game_code(self):
        if sys.platform != "win32":
            self.skipTest("historical CLI is Windows-only")
        import msvcrt
        with tempfile.TemporaryDirectory() as tmp, patch("settings.REPOSITORY", Path(tmp)):
            legacy = Path(tmp) / "prototypes/maa"
            legacy.mkdir(parents=True)
            settings = Settings("maa-live", Path(tmp) / ".artifacts/live", "controller", "token")
            paths = settings.lock_paths()
            self.assertEqual(paths, [Path(tmp) / ".artifacts/device.lock", legacy / ".artifacts/device.lock"])
            held = DeviceLocks(paths)
            try:
                # Same path and byte-range algorithm as the preserved CLI; no native import/execution.
                with paths[1].open("a+b") as stream:
                    stream.seek(0)
                    with self.assertRaises(OSError):
                        msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            finally:
                held.close()


if __name__ == "__main__":
    unittest.main()

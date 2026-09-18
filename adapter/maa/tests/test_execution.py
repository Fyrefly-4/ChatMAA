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
from types import SimpleNamespace
from settings import Settings

FIXTURE = json.loads((Path(__file__).resolve().parents[1] / "fixtures/verified-first-battle.json").read_text(encoding="utf-8"))["events"]


def request(count=10, identity="op"):
    return SimpleNamespace(model_dump=lambda: {"id": identity, "params": {"stage": "1-7", "count": count, "medicine": 0, "premium": 0}})


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
                            raise ResourceLoadError("resource unavailable before instance creation")
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





if __name__ == "__main__":
    unittest.main()

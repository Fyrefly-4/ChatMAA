import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from execution import execute_operation, projection
from settings import Settings
from native import Session
from test_fight_evidence import cycle, event
from test_inventory import info, terminal


class OperationHarness:
    def __init__(self, fail_scan=False, fail_after=False):
        self.calls = []
        self.fail_scan, self.fail_after = fail_scan, fail_after

    def core(self, installation, output, **kwargs):
        parent = self
        if self.fail_after and output.name == "after-check":
            raise RuntimeError("unclassified postcheck failure")

        class FakeCore:
            version = "v6.17.5"
            callback_error = None
            handle = 1

            def __init__(self):
                self.events = []
                self.event_lock = threading.Lock()
                self.lib = self

            def connect(self, connection):
                parent.calls.append(("connect", connection))

            def write(self, kind, **values):
                parent.calls.append((kind, values))

            def AsstAppendTask(self, handle, kind, raw):
                self.kind, self.params = kind.decode(), json.loads(raw)
                parent.calls.append((self.kind, self.params))
                return 7 if self.kind == "Depot" else 1

            def AsstStart(self, handle):
                if self.kind == "Custom":
                    self.events = [{"kind": "callback", "message": 20001,
                                    "details": {"taskchain": "Custom", "taskid": 1, "details": {
                                        "task": "ChatMAAReadyHome", "algorithm": "MatchTemplate", "action": "Stop"}}},
                                   {"kind": "callback", "message": 10002, "details": {"taskchain": "Custom", "taskid": 1}}]
                    overlay = json.loads((kwargs["incremental"] / "resource/tasks/tasks.json").read_text())
                    if "ChatMAADepotReturn" in overlay:
                        parent.calls.append(("return_policy", overlay))
                elif self.kind == "Depot":
                    self.events = [info({"30012": 72}, True), terminal()]
                    if parent.fail_scan:
                        self.events.append(terminal(20000))
                else:
                    self.events = cycle(1, 2) + cycle(2, 4) + [event(10002)]
                return True

            def AsstRunning(self, handle):
                return False

            def AsstStop(self, handle):
                return True

            def close(self):
                parent.calls.append(("closed", self.kind))

        return FakeCore()


class NativeOperationTest(unittest.TestCase):
    def test_connection_error_outside_taskchain_invalidates_inventory(self):
        events = [info({"30012": 72}, True), terminal(),
                  {"kind": "callback", "message": 2, "details": {"what": "Disconnect"}}]
        result = projection(events, 7, {"kind": "scan_inventory"}, True)
        self.assertFalse(result["inventory_result"]["complete"])
        self.assertIn("core_or_connection_error", result["errors"])

    def test_stop_is_delivered_even_when_trace_storage_fails(self):
        from unittest.mock import Mock
        core = Mock()
        core.write.side_effect = OSError("disk unavailable")
        session = Session(core)
        session.stop()
        session.stopper.join(1)
        core.lib.AsstStop.assert_called_once_with(core.handle)
        self.assertIsNotNone(session.stop_error)

    def run_operation(self, params, harness, output):
        settings = Settings("maa-live", output, "c", "t", installation=output,
                            connection={"kind": "mumu", "adb": "fixture", "address": "127.0.0.1:16384", "config": "MuMuEmulator12"})
        return execute_operation(settings, {"id": "test", "params": params}, threading.Event(), lambda *args: None, output, harness.core)

    def test_scan_native_path_maps_depot_and_returns_through_bounded_navigation(self):
        with tempfile.TemporaryDirectory() as tmp:
            harness = OperationHarness()
            result = self.run_operation({"version": 2, "kind": "scan_inventory"}, harness, Path(tmp))
            self.assertTrue(result["inventory_result"]["complete"])
            self.assertTrue(result["environment"]["ready"])
            self.assertIn(("Depot", {}), harness.calls)
            self.assertFalse(any(k == "Fight" for k, _ in harness.calls))
            policies = [v for k, v in harness.calls if k == "return_policy"]
            self.assertEqual(len(policies), 2)
            for p in policies:
                self.assertEqual(p["ChatMAADepotReturn"]["next"], ["ChatMAAReadyHome"])
                self.assertEqual(p["ChatMAADepotReturn"]["maxTimes"], 1)
                self.assertEqual(p["ChatMAADepotMaterial"]["next"], ["ChatMAADepotReturn"])

    def test_scan_error_does_not_navigate_or_unlock_after_done(self):
        with tempfile.TemporaryDirectory() as tmp:
            harness = OperationHarness(fail_scan=True)
            result = self.run_operation({"version": 2, "kind": "scan_inventory"}, harness, Path(tmp))
            self.assertFalse(result["inventory_result"]["complete"])
            self.assertFalse(result["environment"]["ready"])
            self.assertEqual(len([k for k, _ in harness.calls if k == "Custom"]), 1)

    def test_material_native_mapping_and_postcheck_failure_preserve_execution(self):
        for fail_after in (False, True):
            with self.subTest(fail_after=fail_after), tempfile.TemporaryDirectory() as tmp:
                harness = OperationHarness(fail_after=fail_after)
                params = {"version": 2, "kind": "fight_material", "stage": "1-7", "series": 1, "item_id": "30012", "quantity": 3,
                          "medicine": 0, "premium": 0}
                result = self.run_operation(params, harness, Path(tmp))
                mapped = next(v for k, v in harness.calls if k == "Fight")
                self.assertEqual(mapped["drops"], {"30012": 3})
                self.assertEqual(mapped["medicine_expire_days"], 0)
                self.assertEqual(result["material_result"]["items"], {"30012": 4})
                self.assertTrue(result["operation_automation_stopped"])
                self.assertEqual(result["automation_stopped"], not fail_after)
                saved = json.loads((Path(tmp) / "execution/result.json").read_text())
                self.assertEqual(saved["material_result"]["certainty"], "exact")


if __name__ == "__main__":
    unittest.main()

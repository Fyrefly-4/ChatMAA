import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from resources import manifest, resource_roots, verify_material
from service import Controller, Submission, RecheckRequest
from settings import Settings
from worker import execute


class ResourceTest(unittest.TestCase):
    def test_non_object_indexes_fail_before_execution(self):
        params = {"version": 2, "kind": "fight_material", "stage": "1-7", "series": 1,
                  "item_id": "30012", "quantity": 1, "medicine": 0, "premium": 0}
        for value in (None, 1, "30012", [], [["30012", {}]]):
            with self.subTest(value=value), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                (root / "resource").mkdir()
                (root / "resource/item_index.json").write_text(json.dumps(value), encoding="utf-8")
                settings = Settings("maa-live", root / "data", "controller", "token", installation=root, hwnd=1)
                emitted = []
                with patch("execution.execute_operation", side_effect=AssertionError("must not execute")) as run:
                    execute(settings, {"id": "invalid-index", "params": params}, threading.Event(),
                            lambda kind, result: emitted.append((kind, result)))
                run.assert_not_called()
                self.assertEqual(len(emitted), 1)
                kind, result = emitted[0]
                self.assertEqual(kind, "operation_finished")
                self.assertEqual(result["reason"], "resource_validation_failed")
                self.assertTrue(result["automation_stopped"])
                self.assertFalse(result["environment"]["ready"])
                self.assertEqual(result["count_result"]["value"], 0)

    def test_invalid_index_allows_explicit_recheck_without_restart(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "resource").mkdir()
            (root / "resource/item_index.json").write_text("null", encoding="utf-8")
            settings = Settings("maa-live", root / "data", "controller", "token", installation=root, hwnd=1)
            checked = threading.Event()
            def probe(settings, execution_id, recheck_id, stop, emit):
                emit("recheck_finished", {"automation_stopped": True,
                    "environment": {"ready": True, "observed_at": time.time(), "basis": "offline_test"}})
                checked.set()
            def drain(control):
                deadline = time.monotonic() + 3
                while control.active and time.monotonic() < deadline:
                    control.drain()
                    time.sleep(0.01)
                self.assertFalse(control.active)
            control = Controller(settings, recheck_worker=probe)
            try:
                with patch("execution.execute_operation", side_effect=AssertionError("must not execute")) as run:
                    control.submit(Submission(id="invalid-index", params={"version": 2, "kind": "fight_material",
                        "stage": "1-7", "series": 1, "medicine": 0, "premium": 0, "item_id": "30012", "quantity": 1}))
                    drain(control)
                    run.assert_not_called()
                before = control.read("invalid-index")
                self.assertEqual(before["state"], "ended")
                self.assertTrue(before["automation_stopped"])
                self.assertEqual(before["device"], "needs_check")
                self.assertEqual(before["reason"], "resource_validation_failed")
                self.assertEqual(len(control.takeovers.status()["blockers"]), 1)
                control.recheck("invalid-index", RecheckRequest(id="explicit-check"))
                self.assertTrue(checked.wait(3))
                drain(control)
                after = control.read("invalid-index")
                self.assertEqual(after["device"], "ready")
                self.assertEqual(after["reason"], before["reason"])
                self.assertEqual(after["count_result"], before["count_result"])
                self.assertEqual(control.takeovers.status()["blockers"], [])
            finally:
                control.db.close()

    def test_platform_roots_and_content_fingerprint(self):
        with tempfile.TemporaryDirectory() as tmp:
            # Windows CI may expose TEMP through an 8.3 alias; compare canonical paths.
            root = Path(tmp).resolve()
            (root / "resource").mkdir()
            index = root / "resource/item_index.json"
            index.write_text(json.dumps({"30012": {"name": "fixture"}}))
            pc = root / "resource/platform_diff/PC"
            (pc / "resource").mkdir(parents=True)
            (root / "cache/resource").mkdir(parents=True)
            self.assertNotIn(pc, resource_roots(root, "mumu"))
            self.assertIn(pc, resource_roots(root, "desktop"))
            before = manifest(root, "mumu")
            verify_material(root, "mumu", {"kind": "fight_material", "item_id": "30012"})
            with self.assertRaises(ValueError):
                verify_material(root, "mumu", {"kind": "fight_material", "item_id": "missing"})
            index.write_text(json.dumps({"30012": {"name": "changed"}}))
            self.assertNotEqual(before["sha256"], manifest(root, "mumu")["sha256"])


if __name__ == "__main__":
    unittest.main()

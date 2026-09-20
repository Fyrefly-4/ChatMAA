import json
from pathlib import Path
import sys
import unittest
from pydantic import TypeAdapter, ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from inventory import summarize_inventory
from operations import ExecutionParams, core_task


def info(values, done=False, task_id=7):
    return {"kind": "callback", "at": 123, "message": 20003,
            "details": {"taskchain": "Depot", "taskid": task_id, "what": "DepotInfo",
                        "details": {"done": done, "data": json.dumps(values)}}}


def terminal(message=10002):
    return {"kind": "callback", "message": message, "details": {"taskchain": "Depot", "taskid": 7}}


class InventoryTest(unittest.TestCase):
    def test_cumulative_scans_are_not_added_missing_is_not_zero(self):
        events = [info({"30012": 72}), info({"30012": 72, "3003": 4}, True), terminal()]
        result = summarize_inventory(events, 7, True)["inventory_result"]
        self.assertEqual(result["items"], {"30012": 72, "3003": 4})
        self.assertTrue(result["complete"])
        self.assertEqual(result["missing_items"], "unknown")
        self.assertFalse(summarize_inventory(events, 7)["inventory_result"]["complete"])

    def test_done_on_failure_or_missing_completion_is_not_reliable(self):
        for events in [[info({"x": 5}, True)], [info({"x": 5}), terminal()],
                       [info({"x": 5}, True), terminal(20000), terminal()],
                       [info({"x": 5}, True, task_id=8), terminal()],
                       [info({"x": 5}), info({"x": 9}, True), terminal()],
                       [info({"x": True}, True), terminal()]]:
            with self.subTest(events=events):
                self.assertFalse(summarize_inventory(events, 7, True)["inventory_result"]["complete"])

    def test_distinct_operations_and_resource_limits(self):
        adapter = TypeAdapter(ExecutionParams)
        scan = adapter.validate_python({"version": 2, "kind": "scan_inventory"}).model_dump()
        self.assertEqual(core_task(scan), ("Depot", {}))
        base = {"version": 2, "kind": "fight_material", "stage": "1-7", "item_id": "30012",
                "quantity": 3, "series": 1, "medicine": 0, "premium": 0}
        kind, params = core_task(adapter.validate_python(base).model_dump())
        self.assertEqual(kind, "Fight")
        self.assertEqual(params["drops"], {"30012": 3})
        limited = adapter.validate_python({**base, "max_count": 2}).model_dump()
        self.assertEqual(core_task(limited)[1]["times"], 2)
        self.assertEqual(core_task(limited)[1]["drops"], {"30012": 3})
        for key in ("medicine", "medicine_expire_days", "stone"):
            self.assertEqual(params[key], 0)
        for invalid in [{**base, "quantity": True}, {**base, "quantity": 0}, {**base, "stone": 1},
                        {**base, "medicine": 1}, {**base, "series": 0}, {**base, "stage": ""},
                        {"version": 2, "kind": "scan_inventory", "quantity": 1}]:
            with self.subTest(invalid=invalid), self.assertRaises(ValidationError):
                adapter.validate_python(invalid)


if __name__ == "__main__":
    unittest.main()

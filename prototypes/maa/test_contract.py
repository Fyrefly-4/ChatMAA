import tempfile
import unittest
import json
import copy
from pathlib import Path

from contract import fight_params, summarize, write_failure_overlay, write_home_probe_overlay, FAILURE_NODES


def event(message, detail):
    return {"kind": "callback", "message": message, "at": 1, "details": {"taskchain": "Fight", "taskid": 7, **detail}}


def cycle_prefix():
    return [event(20003, {"what": "FightTimes", "details": {"series": 1}}),
            event(20002, {"details": {"task": "StartButton2", "exec_times": 1}}),
            event(20001, {"details": {"task": "EndOfAction"}})]


class ContractTest(unittest.TestCase):
    def test_budget_and_resource_limits(self):
        for invalid in [0, 4, -1, True, "3"]:
            with self.assertRaises(ValueError):
                fight_params(invalid)
        params = fight_params(3)
        self.assertEqual([params[k] for k in ("medicine", "medicine_expire_days", "stone")], [0, 0, 0])
        self.assertEqual(params["series"], 1)
        self.assertEqual(params["client_type"], "")

    def test_queue_completion_is_not_success_count(self):
        result = summarize([event(10002, {})], 7, 3)
        self.assertEqual(result["observed_successes"], 0)
        self.assertFalse(result["matches_requested_evidence"])

    def test_missing_batch_count_remains_unknown(self):
        result = summarize([event(20003, {"what": "StageDrops", "details": {"stage": {"stageCode": "1-7"}, "stars": 3}})], 7, 1)
        self.assertTrue(result["count_unknown"])
        self.assertEqual(result["observed_successes"], 0)

    def test_stage_and_task_identity(self):
        good = event(20003, {"what": "StageDrops", "details": {"stage": {"stageCode": "1-7"}, "stars": 3, "cur_times": 1}})
        self.assertEqual(summarize([good], 8, 1)["observed_successes"], 0)
        result = summarize([*cycle_prefix(), good, event(10002, {})], 7, 1)
        self.assertTrue(result["matches_requested_evidence"])
        self.assertEqual(result["onsite_verification"], "pending")

    def test_real_single_battle_without_cur_times(self):
        events = json.loads((Path(__file__).parent / "evidence/verified-first-battle.json").read_text(encoding="utf-8"))["events"]
        result = summarize(events, 1, 3)
        self.assertEqual(result["observed_successes"], 1)
        self.assertFalse(result["count_unknown"])
        self.assertFalse(result["matches_requested_evidence"])
        replay = summarize(events + events, 1, 3)
        self.assertEqual(replay["observed_successes"], 1)
        self.assertFalse(replay["count_unknown"])

    def test_missing_cycle_evidence_or_conflicting_count_remains_unknown(self):
        source = json.loads((Path(__file__).parent / "evidence/verified-first-battle.json").read_text(encoding="utf-8"))["events"]
        for missing in ("FightTimes", "StartButton2", "EndOfAction"):
            events = [e for e in source if e["details"].get("what") != missing and e["details"]["details"].get("task") != missing]
            result = summarize(events, 1, 3)
            self.assertEqual(result["observed_successes"], 0, missing)
            self.assertTrue(result["count_unknown"], missing)
        for field, value in (("stars", 2), ("cur_times", 2), ("cur_times", None)):
            events = copy.deepcopy(source)
            next(e["details"]["details"] for e in events if e["details"].get("what") == "StageDrops")[field] = value
            self.assertTrue(summarize(events, 1, 3)["count_unknown"])

    def test_three_distinct_cycles_are_required_for_target(self):
        source = json.loads((Path(__file__).parent / "evidence/verified-first-battle.json").read_text(encoding="utf-8"))["events"]
        events = []
        for number in (1, 2, 3):
            batch = copy.deepcopy(source)
            for e in batch:
                if e["details"]["details"].get("task") == "StartButton2":
                    e["details"]["details"]["exec_times"] = number
            events += batch
        events.append({"kind": "callback", "at": 2, "message": 10002, "details": {"taskchain": "Fight", "taskid": 1}})
        result = summarize(events, 1, 3)
        self.assertEqual(result["observed_successes"], 3)
        self.assertTrue(result["matches_requested_evidence"])

    def test_failure_overrides_are_confined_to_fight(self):
        import json
        with tempfile.TemporaryDirectory() as folder:
            policy = write_failure_overlay(Path(folder))
            patch = json.loads((policy / "resource/tasks/tasks.json").read_text())
            self.assertEqual(set(patch), {"Fight@" + n for n in FAILURE_NODES})
            self.assertTrue(all(n["action"] == "Stop" and not n["next"] for n in patch.values()))

    def test_recognition_probe_cannot_navigate_or_click(self):
        import json
        with tempfile.TemporaryDirectory() as folder:
            policy = write_home_probe_overlay(Path(folder))
            patch = json.loads((policy / "resource/tasks/tasks.json").read_text())
            self.assertEqual(set(patch), {"Fight"})
            self.assertEqual(patch["Fight"]["action"], "Stop")
            for field in ("sub", "next", "onErrorNext", "exceededNext"):
                self.assertEqual(patch["Fight"][field], [])


if __name__ == "__main__":
    unittest.main()

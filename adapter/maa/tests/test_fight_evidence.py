import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fight_evidence import summarize_fight
from evidence import uncertain


PARAMS = {"kind": "fight_material", "stage": "1-7", "series": 1, "item_id": "30012", "quantity": 3}


def event(message, data=None, what=None):
    return {"kind": "callback", "at": 0, "message": message,
            "details": {"taskchain": "Fight", "taskid": 1, "what": what, "details": data or {}}}


def cycle(index, total, series=1):
    return [event(20003, {"series": series}, "FightTimes"),
            event(20002, {"task": "StartButton2", "exec_times": index}),
            event(20001, {"task": "EndOfAction"}),
            event(20003, {"stage": {"stageCode": "1-7"}, "stars": 3, "cur_times": series,
                          "drops": [{"itemId": "30012", "quantity": 2}],
                          "stats": [{"itemId": "30012", "quantity": total}]}, "StageDrops"),
            event(20002, {"task": "EndOfAction"})]


class FightEvidenceTest(unittest.TestCase):
    def test_interruption_cannot_strengthen_conflicting_evidence(self):
        result = uncertain({"material_result": {"items": {"30012": 2}, "certainty": "unknown", "issues": ["conflict"]},
                            "count_result": {"value": 1, "certainty": "exact", "issues": []}}, "worker_error")
        self.assertEqual(result["material_result"]["certainty"], "unknown")
        self.assertEqual(result["count_result"]["certainty"], "lower_bound")

    def test_replay_and_identical_drops_in_different_cycles(self):
        events = cycle(1, 2)
        events.insert(4, copy.deepcopy(events[3]))
        events += cycle(2, 4) + [event(10002)]
        result = summarize_fight(events, 1, PARAMS, True)
        self.assertEqual(result["count_result"]["value"], 2)
        self.assertEqual(result["material_result"]["items"], {"30012": 4})
        self.assertEqual(result["material_result"]["certainty"], "exact")
        self.assertTrue(result["threshold_reached"])

    def test_partial_is_exact_and_drops_are_not_multiplied(self):
        params = {**PARAMS, "kind": "fight_count", "count": 10, "series": 2}
        result = summarize_fight(cycle(1, 2, 2) + [event(10002)], 1, params, True)
        self.assertEqual(result["count_result"], {"value": 2, "certainty": "exact", "issues": []})
        self.assertFalse(result["threshold_reached"])
        self.assertEqual(result["material_result"]["items"], {"30012": 2})

    def test_missing_drops_preserves_count_but_stops_material_progress(self):
        events = cycle(1, 2)
        del events[3]["details"]["details"]["drops"]
        result = summarize_fight(events + [event(10002)], 1, PARAMS, True)
        self.assertEqual(result["count_result"]["certainty"], "exact")
        self.assertEqual(result["material_result"]["certainty"], "lower_bound")
        self.assertFalse(result["threshold_reached"])
        events = cycle(1, 2)
        del events[3]
        result = summarize_fight(events, 1, PARAMS)
        self.assertIn("missing_settlement_drops", result["errors"])

    def test_unsettled_end_and_wrong_identity_never_fill_target(self):
        events = cycle(1, 2) + cycle(2, 4)[:2]
        result = summarize_fight(events, 1, PARAMS, True)
        self.assertEqual(result["material_result"]["items"], {"30012": 2})
        self.assertEqual(result["count_result"]["certainty"], "lower_bound")
        self.assertEqual(result["unsettled_cycles"], 1)
        result = summarize_fight(events, 999, PARAMS)
        self.assertEqual(result["count_result"]["value"], 0)

    def test_stats_are_compared_to_increment_not_added(self):
        events = cycle(1, 2) + cycle(2, 100)
        result = summarize_fight(events, 1, PARAMS, True)
        self.assertEqual(result["material_result"]["items"], {"30012": 2})
        self.assertIn("invalid_or_conflicting_drop_totals", result["errors"])

    def test_stop_during_start_click_does_not_claim_exact_zero(self):
        events = [event(20003, {"series": 1}, "FightTimes"), event(20001, {"task": "StartButton2"})]
        result = summarize_fight(events, 1, PARAMS, True)
        self.assertEqual(result["count_result"]["value"], 0)
        self.assertEqual(result["count_result"]["certainty"], "lower_bound")
        self.assertEqual(result["unsettled_cycles"], 1)


if __name__ == "__main__":
    unittest.main()

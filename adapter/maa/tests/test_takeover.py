import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import HTTPException
from service import Controller, Submission
from settings import Settings
from takeover import TakeoverRequest


class TakeoverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.settings = Settings("maa-replay", Path(self.temp.name), "controller", "token")
        self.calls = 0
        self.release = threading.Event()
        self.release.set()
        self.ready = True
        self.stopped = True
        self.c = self.controller()
        self.addCleanup(lambda: self.c.db.close())
        self.old = {"id": "old", "seq": 0, "state": "unknown", "confirmed": 1,
            "certainty": "lower_bound", "automation_stopped": False, "device": "needs_check",
            "reason": "executor_restarted", "started_cycles": 2, "unsettled_cycles": 1}
        self.c.db.execute("INSERT INTO executions VALUES(?,?,?)", ("old", "{}", json.dumps(self.old)))

    def controller(self):
        def probe(settings, execution, check, stop, emit):
            self.calls += 1
            self.release.wait(2)
            emit("recheck_finished", {"automation_stopped": self.stopped,
                "environment": {"ready": self.ready, "observed_at": time.time(), "basis": "test"}})
        return Controller(self.settings, recheck_worker=probe)

    def request(self, identity="check"):
        return TakeoverRequest(id=identity, confirmed=True,
            targets=[{"id": "old", "seq": self.c.read("old")["seq"]}])

    def settle(self):
        deadline = time.monotonic() + 3
        while self.c.active and time.monotonic() < deadline:
            self.c.drain()
            time.sleep(.01)
        self.assertFalse(self.c.active)

    def test_release_preserves_facts_duplicate_and_restart_never_reprobe(self):
        request = self.request()
        self.c.takeovers.start(request)
        self.c.takeovers.start(request)
        self.settle()
        snap = self.c.read("old")
        for key in self.old:
            if key != "seq": self.assertEqual(snap[key], self.old[key])
        self.assertTrue(snap["takeover"]["released"])
        self.c.db.close()
        self.c = self.controller()
        self.assertEqual(self.c.takeovers.start(request)["state"], "succeeded")
        self.assertFalse(self.c.takeovers.status()["blockers"])
        self.assertEqual(self.calls, 1)
        self.assertEqual(self.c.read("old"), snap)

    def test_active_and_current_uncertain_cannot_be_bypassed(self):
        self.c.takeovers.owned.add("old")
        with self.assertRaises(HTTPException): self.c.takeovers.start(self.request())
        self.c.takeovers.owned.clear()
        self.c.active["another"] = {"stop": threading.Event()}
        with self.assertRaises(HTTPException): self.c.takeovers.start(self.request())
        self.assertEqual(self.calls, 0)
        self.c.active.clear()

    def test_failure_and_unconfirmed_probe_keep_admission_closed(self):
        self.stopped = False
        self.c.takeovers.start(self.request())
        self.settle()
        self.assertEqual(self.c.takeovers.status()["recovery"]["reason"], "probe_stop_unconfirmed")
        self.assertFalse(self.c.takeovers.status()["recoverable"])
        self.assertNotIn("takeover", self.c.read("old"))
        with self.assertRaises(HTTPException): self.c.takeovers.start(self.request("again"))

    def test_failed_ready_check_requires_explicit_new_attempt(self):
        self.ready = False
        request = self.request()
        self.c.takeovers.start(request)
        self.settle()
        self.ready = True
        self.c.takeovers.start(request)
        self.assertEqual(self.calls, 1)
        self.c.takeovers.start(self.request("second"))
        self.settle()
        self.assertEqual(self.calls, 2)
        self.assertTrue(self.c.read("old")["takeover"]["released"])

    def test_stale_scope_and_false_confirmation_do_not_probe(self):
        request = self.request()
        self.c.record("old", "new_evidence")
        with self.assertRaises(HTTPException): self.c.takeovers.start(request)
        request = self.request()
        request.confirmed = False
        with self.assertRaises(HTTPException): self.c.takeovers.start(request)
        self.assertEqual(self.calls, 0)

    def test_shutdown_during_probe_never_releases(self):
        self.release.clear()
        self.c.takeovers.start(self.request())
        self.c.retire("test", await_ack=True)
        self.release.set()
        self.settle()
        self.assertNotIn("takeover", self.c.read("old"))

    def test_pending_probe_blocks_submit_and_second_recovery(self):
        self.release.clear()
        self.c.takeovers.start(self.request())
        with self.assertRaises(HTTPException): self.c.takeovers.start(self.request("second"))
        with self.assertRaises(HTTPException): self.c.submit(Submission(id="new",
            params={"stage": "1-7", "count": 1, "medicine": 0, "premium": 0}))
        self.release.set()
        self.settle()

    def test_restart_marks_pending_intent_interrupted_and_does_not_retry(self):
        request = self.request()
        self.c.takeovers.save({"id": request.id, "request": request.model_dump(),
            "state": "running", "automation_stopped": False, "reason": None})
        self.c.db.close()
        self.c = self.controller()
        self.assertEqual(self.c.takeovers.start(request)["state"], "interrupted")
        self.assertEqual(self.calls, 0)
        self.assertTrue(self.c.takeovers.status()["recoverable"])

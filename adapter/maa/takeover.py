"""人工接管仅解除准入阻塞，不改写历史执行结果。"""
import json
import threading
import time

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field
from readiness import fresh


def released(snapshot):
    return snapshot.get("takeover", {}).get("released") is True


def blocked(snapshot):
    return not released(snapshot) and (snapshot["state"] != "ended" or
        not snapshot["automation_stopped"] or snapshot["device"] != "ready")


class Target(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,80}$")
    seq: int = Field(ge=0)


class TakeoverRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,80}$")
    confirmed: bool
    targets: list[Target] = Field(min_length=1)


class Takeovers:
    key = "@takeover"

    def __init__(self, controller):
        self.c = controller
        self.owned = set()
        self.uncertain_probe = False
        controller.db.execute("CREATE TABLE IF NOT EXISTS takeovers(id TEXT PRIMARY KEY, body TEXT NOT NULL)")
        for row in controller.db.execute("SELECT id, body FROM takeovers").fetchall():
            value = json.loads(row["body"])
            if value["state"] == "running":
                value.update(state="interrupted", reason="executor_restarted", automation_stopped=False)
                self.save(value)

    def save(self, value):
        self.c.db.execute("INSERT OR REPLACE INTO takeovers VALUES(?,?)", (value["id"], json.dumps(value)))

    def status(self):
        c = self.c
        snapshots = [json.loads(r[0]) for r in c.db.execute("SELECT snapshot FROM executions")]
        blockers = [{"id": s["id"], "seq": s["seq"], "confirmed": s["confirmed"],
            "certainty": s["certainty"], "reason": s["reason"],
            "kind": "current" if s["id"] in self.owned else "historical"} for s in snapshots if blocked(s)]
        row = c.db.execute("SELECT body FROM takeovers ORDER BY rowid DESC LIMIT 1").fetchone()
        return {"blockers": blockers, "recoverable": bool(blockers) and not c.active and
            not self.uncertain_probe and not c.retiring and not c.storage_failed and
            all(b["kind"] == "historical" for b in blockers),
            "recovery": json.loads(row[0]) if row else None}

    def start(self, body):
        c = self.c
        old = c.db.execute("SELECT body FROM takeovers WHERE id=?", (body.id,)).fetchone()
        if old:
            value = json.loads(old[0])
            if value["request"] != body.model_dump():
                raise HTTPException(409, "recovery_id_conflict")
            return value
        if c.retiring or time.monotonic() - c.last_lease > c.settings.lease_ms / 1000:
            raise HTTPException(409, "controller_retired")
        status = self.status()
        expected = sorted((b["id"], b["seq"]) for b in status["blockers"])
        actual = sorted((t.id, t.seq) for t in body.targets)
        if not body.confirmed or not status["recoverable"] or actual != expected:
            raise HTTPException(409, "recovery_preconditions_changed")
        value = {"id": body.id, "request": body.model_dump(), "state": "running",
                 "automation_stopped": False, "reason": None}
        self.save(value)  # Durable intent before any probe; repeating this ID never launches another.
        stop = threading.Event()
        c.active[self.key] = {"stop": stop, "kind": "takeover", "value": value}
        def run():
            try:
                c.recheck_worker(c.settings, self.key, body.id, stop,
                    lambda kind, result: c.inbox.put((self.key, kind, result)))
            except Exception:
                c.inbox.put((self.key, "recheck_finished", {"automation_stopped": False}))
        threading.Thread(target=run, daemon=True).start()
        return value

    def finish(self, result):
        c = self.c
        control = c.active[self.key]
        value = control["value"]
        environment = {k: v for k, v in result.get("environment", {}).items()
                       if k in ("ready", "observed_at", "basis")}
        stopped = result.get("automation_stopped") is True
        self.uncertain_probe = not stopped
        ready = stopped and fresh(environment) and not control["stop"].is_set() and not c.retiring
        targets = value["request"]["targets"]
        ready = ready and all(c.read(t["id"])["seq"] == t["seq"] for t in targets)
        value.update(state="succeeded" if ready else "failed", automation_stopped=stopped,
                     environment=environment, reason=None if ready else
                     ("probe_stop_unconfirmed" if not stopped else "environment_not_ready"))
        # One transaction publishes all releases and the probe outcome together.
        c.db.execute("BEGIN IMMEDIATE")
        try:
            if ready:
                for target in targets:
                    snap = c.read(target["id"])
                    snap.update(seq=snap["seq"] + 1, updated_at=time.time(),
                        takeover={"id": value["id"], "released": True, "environment": environment})
                    event = {"id": snap["id"], "seq": snap["seq"], "kind": "manual_takeover",
                             "source_instance": c.instance, "snapshot": snap}
                    c.db.execute("UPDATE executions SET snapshot=? WHERE id=?", (json.dumps(snap), snap["id"]))
                    c.db.execute("INSERT INTO events VALUES(?,?,?)", (snap["id"], snap["seq"], json.dumps(event)))
            self.save(value)
            c.db.execute("COMMIT")
        except Exception:
            c.db.execute("ROLLBACK")
            raise

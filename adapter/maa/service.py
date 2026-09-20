"""本机 HTTP 控制层；沿用原型事务、租约与退出交接，去除实验管理接口。"""
import asyncio
import contextlib
import hmac
import json
import os
import queue
import sqlite3
import threading
import time
import uuid

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from contract import MAX_COUNT
from readiness import fresh
from worker import execute, recheck
from operations import ExecutionParams
from evidence import uncertain
from takeover import Takeovers, TakeoverRequest, blocked, released


def environment_view(evidence):
    """上游只接收识别结论；原始异常留在本地事件 detail 中。"""
    result = dict(evidence)
    if result.get("error"):
        result["error"] = "environment_check_failed"
    return result


class Params(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    stage: str = Field(pattern=r"^1-7$")
    count: int = Field(ge=1, le=MAX_COUNT)
    medicine: int = Field(ge=0, le=0)
    premium: int = Field(ge=0, le=0)


class Submission(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,80}$")
    params: Params | ExecutionParams


class RecheckRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,80}$")


class Controller:
    def __init__(self, settings, worker=execute, recheck_worker=recheck):
        self.settings, self.worker = settings, worker
        self.recheck_worker = recheck_worker
        self.instance = str(uuid.uuid4())
        settings.data.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(settings.data / "executor.sqlite", isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.executescript('''PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS executions(id TEXT PRIMARY KEY, params TEXT NOT NULL, snapshot TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS events(id TEXT NOT NULL, seq INTEGER NOT NULL, evidence TEXT NOT NULL, PRIMARY KEY(id, seq));''')
        self.active = {}
        self.inbox = queue.SimpleQueue()
        self.storage_failed = False
        self.retiring = False
        self.awaiting_ack = False
        self.retire_at = None
        self.last_lease = time.monotonic()
        self.takeovers = Takeovers(self)
        for row in self.db.execute("SELECT id, snapshot FROM executions").fetchall():
            snap = json.loads(row["snapshot"])
            if released(snap):
                continue
            if snap.get("recheck", {}).get("state") in ("running", "stopping"):
                self.record(row["id"], "recheck_interrupted", device="needs_check",
                            recheck={**snap["recheck"], "state": "unknown", "automation_stopped": False})
            if snap["state"] != "ended":
                self.record(row["id"], "recovered_uncertain", state="unknown", certainty="lower_bound",
                            device="needs_check", reason="executor_restarted", automation_stopped=False,
                            **uncertain(snap, "executor_restarted"))

    def trace(self, kind, **values):
        line = json.dumps({"kind": kind, "at": time.time(), **values})
        try:
            with (self.settings.data / "executor-trace.jsonl").open("a", encoding="utf-8") as stream:
                stream.write(line + "\n")
            print(line, flush=True)
        except OSError:
            pass

    def read(self, execution_id):
        row = self.db.execute("SELECT snapshot FROM executions WHERE id=?", (execution_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "unknown_execution")
        return json.loads(row[0])

    def record(self, execution_id, kind, detail=None, **changes):
        snap = self.read(execution_id)
        snap.pop("takeover", None)
        snap.update(changes)
        snap.update(seq=snap["seq"] + 1, updated_at=time.time())
        evidence = {"id": execution_id, "seq": snap["seq"], "kind": kind,
                    "source_instance": self.instance, "snapshot": snap, "detail": detail}
        try:
            self.db.execute("BEGIN IMMEDIATE")
            self.db.execute("UPDATE executions SET snapshot=? WHERE id=?", (json.dumps(snap), execution_id))
            self.db.execute("INSERT INTO events VALUES(?,?,?)", (execution_id, snap["seq"], json.dumps(evidence)))
            self.db.execute("COMMIT")
        except sqlite3.Error:
            if self.db.in_transaction:
                self.db.execute("ROLLBACK")
            self.storage_failed = True
            raise
        return snap

    def request_stop(self, execution_id):
        control = self.active.get(execution_id)
        if control:
            control["stop"].set()  # Signal first, even when persistence is broken.
            try:
                if control.get("kind") == "takeover":
                    return
                if control.get("kind") == "recheck":
                    self.record(execution_id, "recheck_stop_requested", recheck={**self.read(execution_id)["recheck"], "state": "stopping"})
                else:
                    self.record(execution_id, "stop_requested", state="stopping", device="occupied", reason="stop_requested")
            except sqlite3.Error:
                pass

    def retire(self, reason, await_ack=False):
        if not self.retiring:
            self.retiring, self.retire_at = True, time.monotonic()
            self.awaiting_ack = await_ack
            self.trace("retiring", reason=reason)
            for execution_id in list(self.active):
                self.request_stop(execution_id)

    def receive(self, execution_id, kind, value):
        control = self.active[execution_id]
        if control.get("kind") == "takeover":
            self.takeovers.finish(value)
            return
        if kind == "recheck_finished":
            stopped = value.get("automation_stopped") is True
            environment = environment_view(value.get("environment", {}))
            ready = stopped and not control["stop"].is_set() and fresh(environment)
            self.record(execution_id, kind, detail=value, device="ready" if ready else "needs_check",
                        recheck={"id": control["recheck_id"], "state": "ended" if stopped else "unknown",
                                 "automation_stopped": stopped, "ready": ready, "environment": environment})
        elif kind == "worker_started":
            self.record(execution_id, kind, state="stopping" if control["stop"].is_set() else "running")
        elif kind in ("operation_progress", "operation_finished"):
            changes = {key: value[key] for key in ("count_result", "material_result", "inventory_result",
                       "threshold_reached", "interpretation_version", "started_cycles", "unsettled_cycles", "evidence_source", "resource_digest") if key in value}
            # Legacy confirmed always denotes successful fights, never inventory/material units.
            changes["confirmed"] = value.get("count_result", {}).get("value", 0)
            changes["certainty"] = value.get("count_result", {}).get("certainty", "lower_bound")
            if kind == "operation_finished":
                stopped = value.get("automation_stopped") is True
                healthy = not value.get("errors") and not any(value.get(k) for k in ("callback_error", "runtime_error", "stop_error"))
                if not stopped or any(value.get(k) for k in ("callback_error", "runtime_error", "stop_error")):
                    changes.update(uncertain(changes, "execution_evidence_incomplete"))
                    changes["certainty"] = changes.get("count_result", {}).get("certainty", "lower_bound")
                environment = environment_view(value.get("environment", {}))
                changes.update(state="ended" if stopped else "unknown", automation_stopped=stopped,
                               device="ready" if stopped and healthy and fresh(environment) else "needs_check",
                               environment=environment, reason=value.get("reason", "unknown"))
            signature = json.dumps(changes, sort_keys=True)
            if kind == "operation_finished" or signature != control.get("projection"):
                control["projection"] = signature
                self.record(execution_id, kind, detail=value, **changes)
            if kind == "operation_progress" and value.get("errors"):
                self.request_stop(execution_id)
        elif kind == "progress":
            signature = json.dumps(value, sort_keys=True)
            if signature != control.get("projection"):
                control["projection"] = signature
                self.record(execution_id, "progress", detail=value, confirmed=value["observed_successes"],
                            started_cycles=value["started_cycles"], unsettled_cycles=value["unsettled_cycles"])
            if value["errors"] or value["count_unknown"]:
                self.request_stop(execution_id)
        elif kind == "finished":
            healthy = not any(value.get(k) for k in ("callback_error", "runtime_error", "stop_error"))
            stopped = value.get("automation_stopped") is True
            exact = value.get("battle_automation_stopped", stopped) and healthy and value["matches_requested_evidence"] and value["unsettled_cycles"] == 0
            environment = environment_view(value.get("environment", {}))
            ready = stopped and healthy and fresh(environment)
            self.record(execution_id, "final_evidence", detail=value, state="ended" if stopped else "unknown",
                        confirmed=value["observed_successes"], certainty="exact" if exact else "lower_bound",
                        device="ready" if ready else "needs_check", environment=environment,
                        reason="target_reached" if exact else value.get("reason", "evidence_incomplete"),
                        automation_stopped=stopped, started_cycles=value["started_cycles"], unsettled_cycles=value["unsettled_cycles"])
        else:
            self.record(execution_id, "worker_error", detail=value, state="unknown", certainty="lower_bound",
                        device="needs_check", reason="worker_error", automation_stopped=False,
                        **uncertain(self.read(execution_id), "worker_error"))

    def drain(self):
        for _ in range(100):
            try:
                execution_id, kind, value = self.inbox.get_nowait()
            except queue.Empty:
                break
            try:
                self.receive(execution_id, kind, value)
            except sqlite3.Error:
                self.storage_failed = True
                self.active[execution_id]["stop"].set()
                self.trace("storage_failed", id=execution_id)
            finally:
                if kind in ("finished", "operation_finished", "worker_error", "recheck_finished"):
                    self.active.pop(execution_id, None)

    def recheck(self, execution_id, body):
        if self.retiring or time.monotonic() - self.last_lease > self.settings.lease_ms / 1000:
            raise HTTPException(409, "controller_retired")
        if self.storage_failed:
            raise HTTPException(503, "storage_unavailable")
        snap = self.read(execution_id)
        # Accepted intent is durable: the same ID is never another probe, including after restart.
        if self.db.execute("SELECT 1 FROM events WHERE id=? AND json_extract(evidence, '$.kind')='recheck_requested' AND json_extract(evidence, '$.detail.recheck_id')=?",
                           (execution_id, body.id)).fetchone():
            return snap
        snapshots = [json.loads(r[0]) for r in self.db.execute("SELECT snapshot FROM executions")]
        if self.active or any(s["state"] != "ended" or not s["automation_stopped"] or
                              (s.get("recheck") and not s["recheck"].get("automation_stopped")) for s in snapshots):
            raise HTTPException(409, "automation_stop_unconfirmed")
        self.takeovers.owned.add(execution_id)
        self.record(execution_id, "recheck_requested", detail={"recheck_id": body.id}, device="occupied",
                    recheck={"id": body.id, "state": "running", "automation_stopped": False, "ready": False})
        stop = threading.Event()
        self.active[execution_id] = {"stop": stop, "kind": "recheck", "recheck_id": body.id}
        def emit(kind, value):
            self.inbox.put((execution_id, kind, value))
        threading.Thread(target=self.recheck_worker, args=(self.settings, execution_id, body.id, stop, emit), daemon=True).start()
        return self.read(execution_id)

    def submit(self, body):
        if self.retiring or time.monotonic() - self.last_lease > self.settings.lease_ms / 1000:
            self.retire("late_command")
            raise HTTPException(409, "controller_retired")
        canonical = json.dumps(body.params.model_dump(), sort_keys=True)
        previous = self.db.execute("SELECT params FROM executions WHERE id=?", (body.id,)).fetchone()
        if previous:
            if previous[0] != canonical:
                raise HTTPException(409, "id_parameter_conflict")
            return self.read(body.id)
        if self.storage_failed:
            raise HTTPException(503, "storage_unavailable")
        snapshots = [json.loads(r[0]) for r in self.db.execute("SELECT snapshot FROM executions")]
        if self.active or self.takeovers.uncertain_probe or any(blocked(s) for s in snapshots):
            raise HTTPException(409, "device_busy_or_uncertain")
        snap = {"id": body.id, "seq": 0, "state": "accepted", "confirmed": 0, "certainty": "lower_bound",
                "device": "occupied", "reason": None, "automation_stopped": False, "started_cycles": 0,
                "unsettled_cycles": 0, "evidence_source": "offline_callback_replay" if self.settings.mode == "maa-replay" else "MaaCore_v6.17.5"}
        if body.params.model_dump().get("version") == 2:
            snap.update(operation=body.params.kind, contract_version=2, interpretation_version=3)
            if self.settings.mode == "maa-replay":
                snap["evidence_source"] = "synthetic_d2_callbacks"
        self.db.execute("INSERT INTO executions VALUES(?,?,?)", (body.id, canonical, json.dumps(snap)))
        self.takeovers.owned.add(body.id)
        self.record(body.id, "accepted")
        stop = threading.Event()
        self.active[body.id] = {"stop": stop}
        def emit(kind, value):
            self.inbox.put((body.id, kind, value))
        thread = threading.Thread(target=self.worker, args=(self.settings, body.model_dump(), stop, emit), daemon=True)
        thread.start()
        return self.read(body.id)

    def query(self, execution_id, after=0):
        snap = self.read(execution_id)
        if self.storage_failed:
            snap.update(state="unknown", certainty="lower_bound", device="needs_check", reason="storage_failed")
            snap.update(uncertain(snap, "storage_failed"))
        events = [json.loads(row[0]) for row in self.db.execute(
            "SELECT evidence FROM events WHERE id=? AND seq>? ORDER BY seq", (execution_id, after))]
        return {"snapshot": snap, "events": events, "instance": self.instance}

    async def supervise(self):
        while True:
            await asyncio.sleep(0.03)
            self.drain()
            if time.monotonic() - self.last_lease > self.settings.lease_ms / 1000:
                self.retire("lease_expired")
            if self.retiring:
                if not self.active and not self.awaiting_ack:
                    self.trace("exit", reason="retired")
                    os._exit(0)
                if time.monotonic() - self.retire_at > self.settings.stop_deadline_ms / 1000:
                    self.trace("final_handoff_expired" if not self.active else "forced_self_exit")
                    os._exit(0 if not self.active else 72)


def create_app(control, port):
    @contextlib.asynccontextmanager
    async def lifespan(app):
        watcher = asyncio.create_task(control.supervise())
        control.trace("ready", instance=control.instance, controller=control.settings.controller,
                      pid=os.getpid(), port=port, mode=control.settings.mode)
        yield
        watcher.cancel()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware("http")
    async def authorize(request: Request, call_next):
        if (request.headers.get("origin") or
            not hmac.compare_digest(request.headers.get("x-control-token", ""), control.settings.token) or
            request.headers.get("x-controller-id") != control.settings.controller or
            request.headers.get("x-instance-id") != control.instance):
            return JSONResponse({"error": "wrong_control_identity"}, status_code=403)
        if control.retiring and request.method != "GET" and request.url.path != "/shutdown":
            return JSONResponse({"error": "controller_retired"}, status_code=409)
        try:
            return await call_next(request)
        except sqlite3.Error:
            control.storage_failed = True
            for active in control.active.values():
                active["stop"].set()
            return JSONResponse({"error": "storage_unavailable"}, status_code=503)

    @app.get("/health")
    async def health():
        return {"retiring": control.retiring, "storage_failed": control.storage_failed, "active": list(control.active)}

    @app.get("/device")
    async def device():
        return control.takeovers.status()

    @app.post("/takeovers", status_code=202)
    async def takeover(body: TakeoverRequest):
        return control.takeovers.start(body)

    @app.post("/lease")
    async def lease():
        if time.monotonic() - control.last_lease > control.settings.lease_ms / 1000:
            control.retire("late_lease")
            raise HTTPException(409, "lease_expired")
        control.last_lease = time.monotonic()
        return {"instance": control.instance}

    @app.post("/executions", status_code=202)
    async def submit(body: Submission):
        return control.submit(body)

    @app.get("/executions/{execution_id}")
    async def query(execution_id: str, after: int = 0):
        return control.query(execution_id, after)

    @app.post("/executions/{execution_id}/stop", status_code=202)
    async def stop(execution_id: str):
        snap = control.read(execution_id)
        control.request_stop(execution_id)
        return {"id": execution_id, "stop_requested": execution_id in control.active,
                "confirmed": snap["automation_stopped"] and execution_id not in control.active and
                (not snap.get("recheck") or snap["recheck"].get("automation_stopped") is True) if snap["state"] == "ended" else False}

    @app.post("/executions/{execution_id}/recheck", status_code=202)
    async def recheck_environment(execution_id: str, body: RecheckRequest):
        return control.recheck(execution_id, body)

    @app.post("/prepare-shutdown", status_code=202)
    async def prepare_shutdown():
        control.retire("application_shutdown", await_ack=True)
        return {"retiring": True, "awaiting_final_ack": True}

    @app.post("/shutdown", status_code=202)
    async def shutdown():
        control.retire("application_shutdown")
        control.awaiting_ack = False
        return {"retiring": True}

    return app

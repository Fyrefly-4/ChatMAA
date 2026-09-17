"""原型 A+B 的 HTTP 边界。工作线程不写 SQLite；主线程不调用 MaaCore。"""
import asyncio
import contextlib
import hashlib
import hmac
import json
import os
from pathlib import Path
import queue
import secrets
import socket
import sqlite3
import sys
import threading
import time
import uuid

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
import uvicorn

from http_worker import execute, ROOT

MODE = os.environ["LAB_BACKEND"]
if MODE not in ("maa-replay", "maa-live"):
    raise RuntimeError("explicit maa-replay / maa-live required")
DATA = Path(os.environ["LAB_DATA"]).resolve()
DATA.mkdir(parents=True, exist_ok=True)
INSTANCE = str(uuid.uuid4())
CONTROLLER = os.environ["LAB_CONTROLLER"]
TOKEN = os.environ["LAB_ADAPTER_TOKEN"]
LEASE = float(os.environ.get("LAB_LEASE_MS", "10000")) / 1000
DEADLINE = float(os.environ.get("LAB_STOP_DEADLINE_MS", "20000")) / 1000
faults = json.loads(os.environ.get("LAB_PY_FAULTS", "{}")) if MODE == "maa-replay" else {}
grant = None
if MODE == "maa-live":
    grant = json.loads(Path(os.environ["MAA_LIVE_GRANT"]).read_text(encoding="utf-8"))
    if grant.get("kind") != "manual_http_experiment" or grant.get("data") != str(DATA):
        raise RuntimeError("live grant does not match this data directory")
    if not grant["output"].startswith("http-") or Path(grant["output"]).name != grant["output"]:
        raise RuntimeError("invalid live output directory")
    with (Path(grant["installation"]) / "MaaCore.dll").open("rb") as source:
        if hashlib.file_digest(source, "sha256").hexdigest() != "295a7aa78f3245a2112924231119d81d65f0fc201f364fed8cf1fb1db62d4b9a":
            raise RuntimeError("MaaCore changed; review required")

# live 固定与 CLI 共用设备锁，不能从环境变量换一个锁而重复占用。
lock_path = ROOT / ".artifacts/device.lock" if MODE == "maa-live" else Path(os.environ["LAB_DEVICE_LOCK"])
lock_path.parent.mkdir(parents=True, exist_ok=True)
device_lock = lock_path.open("a+b")
if os.fstat(device_lock.fileno()).st_size == 0:
    device_lock.write(b"0")
    device_lock.flush()
device_lock.seek(0)
try:
    if sys.platform == "win32":
        import msvcrt
        msvcrt.locking(device_lock.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        import fcntl
        fcntl.flock(device_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError:
    print(json.dumps({"kind": "device_busy"}), flush=True)
    sys.exit(23)

db = sqlite3.connect(DATA / "executor.sqlite", isolation_level=None)
db.row_factory = sqlite3.Row
db.executescript("""
PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;
CREATE TABLE IF NOT EXISTS executions(id TEXT PRIMARY KEY, params TEXT NOT NULL, snapshot TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events(id TEXT NOT NULL, seq INTEGER NOT NULL, evidence TEXT NOT NULL, PRIMARY KEY(id, seq));
""")
active = {}
inbox = queue.SimpleQueue()
storage_failed = False
retiring = False
retire_at = None
last_lease = time.monotonic()


def trace(kind, **values):
    line = json.dumps({"kind": kind, "at": time.time(), **values})
    try:
        with (DATA / "executor-trace.jsonl").open("a", encoding="utf-8") as output:
            output.write(line + "\n")
        print(line, flush=True)
    except OSError:
        pass


def read(execution_id):
    row = db.execute("SELECT snapshot FROM executions WHERE id=?", (execution_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "unknown_execution")
    return json.loads(row[0])


def record(execution_id, kind, detail=None, **changes):
    global storage_failed
    snap = read(execution_id)
    snap.update(changes)
    snap.update(seq=snap["seq"] + 1, updated_at=time.time())
    evidence = {"id": execution_id, "seq": snap["seq"], "kind": kind,
                "source_instance": INSTANCE, "snapshot": snap, "detail": detail}
    try:
        db.execute("BEGIN IMMEDIATE")
        db.execute("UPDATE executions SET snapshot=? WHERE id=?", (json.dumps(snap), execution_id))
        db.execute("INSERT INTO events VALUES(?,?,?)", (execution_id, snap["seq"], json.dumps(evidence)))
        db.execute("COMMIT")
    except sqlite3.Error:
        if db.in_transaction:
            db.execute("ROLLBACK")
        storage_failed = True
        raise
    trace("evidence", evidence=evidence)
    return snap


for row in db.execute("SELECT id, snapshot FROM executions").fetchall():
    if json.loads(row["snapshot"])["state"] != "ended":
        record(row["id"], "recovered_uncertain", state="unknown", certainty="lower_bound",
               device="needs_check", reason="executor_restarted", automation_stopped=False)


class Params(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    stage: str = Field(pattern=r"^1-7$")
    count: int = Field(ge=1, le=3)
    medicine: int = Field(ge=0, le=0)
    premium: int = Field(ge=0, le=0)


class Submission(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,80}$")
    params: Params


def request_stop(execution_id):
    control = active.get(execution_id)
    if control:
        # 即使落库失败，也先把停止意图传给 native 工作线程。
        control["stop"].set()
        try:
            record(execution_id, "stop_requested", state="stopping", device="occupied", reason="stop_requested")
        except sqlite3.Error:
            pass


def retire(reason):
    global retiring, retire_at
    if not retiring:
        retiring, retire_at = True, time.monotonic()
        trace("retiring", reason=reason)
        for execution_id in list(active):
            request_stop(execution_id)


def receive(execution_id, kind, value):
    control = active[execution_id]
    if kind == "worker_started":
        record(execution_id, kind, state="stopping" if control["stop"].is_set() else "running")
    elif kind == "progress":
        # 只持久化语义变化；raw callbacks 由原来的 Core 逐条落盘。
        signature = json.dumps(value, sort_keys=True)
        if signature != control.get("projection"):
            control["projection"] = signature
            record(execution_id, "progress", detail=value, confirmed=value["observed_successes"],
                   started_cycles=value["started_cycles"], unsettled_cycles=value["unsettled_cycles"])
        if value["errors"] or value["count_unknown"]:
            request_stop(execution_id)
    elif kind == "finished":
        healthy = not any(value.get(key) for key in ("callback_error", "runtime_error", "stop_error"))
        stopped = value.get("automation_stopped") is True
        exact = stopped and healthy and value["matches_requested_evidence"] and value["unsettled_cycles"] == 0
        record(execution_id, "final_evidence", detail=value,
               state="ended" if stopped else "unknown", confirmed=value["observed_successes"],
               certainty="exact" if exact else "lower_bound", device="needs_check",
               reason="target_reached" if exact else value.get("reason", "evidence_incomplete"),
               automation_stopped=stopped, started_cycles=value["started_cycles"],
               unsettled_cycles=value["unsettled_cycles"])
    else:
        record(execution_id, "worker_error", detail=value, state="unknown", certainty="lower_bound",
               device="needs_check", reason="worker_error", automation_stopped=False)


async def supervise():
    global storage_failed
    while True:
        await asyncio.sleep(0.03)
        # 有限批量，避免大量回调阻塞 HTTP 和失联判定。
        for _ in range(100):
            try:
                execution_id, kind, value = inbox.get_nowait()
            except queue.Empty:
                break
            try:
                receive(execution_id, kind, value)
            except sqlite3.Error:
                storage_failed = True
                active[execution_id]["stop"].set()
                trace("storage_failed", id=execution_id)
            finally:
                if kind in ("finished", "worker_error"):
                    active.pop(execution_id, None)
        if time.monotonic() - last_lease > LEASE:
            retire("lease_expired")
        if retiring:
            if not active:
                trace("exit", reason="retired")
                os._exit(0)
            if time.monotonic() - retire_at > DEADLINE:
                trace("forced_self_exit", reason="stop_deadline")
                os._exit(72)


@contextlib.asynccontextmanager
async def lifespan(app):
    watcher = asyncio.create_task(supervise())
    trace("ready", instance=INSTANCE, controller=CONTROLLER, pid=os.getpid(), port=sock.getsockname()[1], mode=MODE)
    yield
    watcher.cancel()


app = FastAPI(lifespan=lifespan)


@app.middleware("http")
async def authorize(request: Request, call_next):
    global storage_failed
    if (request.headers.get("origin") or
        not hmac.compare_digest(request.headers.get("x-control-token", ""), TOKEN) or
        request.headers.get("x-controller-id") != CONTROLLER or
        request.headers.get("x-instance-id") != INSTANCE):
        return JSONResponse({"error": "wrong_control_identity"}, status_code=403)
    if retiring and request.method != "GET":
        return JSONResponse({"error": "controller_retired"}, status_code=409)
    try:
        return await call_next(request)
    except sqlite3.Error:
        storage_failed = True
        for control in active.values():
            control["stop"].set()
        return JSONResponse({"error": "storage_unavailable"}, status_code=503)


@app.get("/health")
async def health():
    return {"mode": MODE, "instance": INSTANCE, "retiring": retiring, "storage_failed": storage_failed,
            "active": list(active)}


@app.post("/lease")
async def lease():
    global last_lease
    if time.monotonic() - last_lease > LEASE:
        retire("late_lease")
        raise HTTPException(409, "lease_expired")
    last_lease = time.monotonic()
    return {"instance": INSTANCE}


@app.post("/executions", status_code=202)
async def submit(body: Submission):
    if time.monotonic() - last_lease > LEASE:
        retire("late_command")
        raise HTTPException(409, "lease_expired")
    params = body.params.model_dump()
    canonical = json.dumps(params, sort_keys=True)
    previous = db.execute("SELECT params FROM executions WHERE id=?", (body.id,)).fetchone()
    if previous:
        if previous[0] != canonical:
            raise HTTPException(409, "id_parameter_conflict")
        return read(body.id)
    if storage_failed:
        raise HTTPException(503, "storage_unavailable")
    if active or db.execute("SELECT 1 FROM executions LIMIT 1").fetchone():
        raise HTTPException(409, "one_operation_per_experiment_requires_manual_check")
    if MODE == "maa-live" and (body.id != grant["id"] or params != grant["params"]):
        raise HTTPException(422, "outside_live_grant")
    snap = {"id": body.id, "seq": 0, "state": "accepted", "confirmed": 0,
            "certainty": "lower_bound", "device": "occupied", "reason": None,
            "automation_stopped": False, "started_cycles": 0, "unsettled_cycles": 0}
    db.execute("INSERT INTO executions VALUES(?,?,?)", (body.id, canonical, json.dumps(snap)))
    record(body.id, "accepted", detail={"mode": MODE, "params": params})
    stop = threading.Event()
    active[body.id] = {"stop": stop}
    def emit(kind, value):
        inbox.put((body.id, kind, value))
    worker = threading.Thread(target=execute, args=(MODE, body.model_dump(), stop, emit, faults.copy(), grant), daemon=True)
    worker.start()
    if faults.pop("drop_response", False):
        await asyncio.sleep(3)
    return read(body.id)


@app.get("/executions/{execution_id}")
async def query(execution_id: str, after: int = 0):
    snap = read(execution_id)
    if storage_failed:
        snap.update(state="unknown", certainty="lower_bound", device="needs_check", reason="storage_failed")
    events = [json.loads(row[0]) for row in db.execute(
        "SELECT evidence FROM events WHERE id=? AND seq>? ORDER BY seq", (execution_id, after))]
    return {"snapshot": snap, "events": events, "instance": INSTANCE}


@app.post("/executions/{execution_id}/stop", status_code=202)
async def stop(execution_id: str):
    read(execution_id)
    request_stop(execution_id)
    return {"id": execution_id, "stop_requested": True, "confirmed": False}


@app.post("/reconcile")
async def reconcile():
    raise HTTPException(409, "real_environment_requires_manual_check")


@app.post("/shutdown", status_code=202)
async def shutdown():
    retire("application_shutdown")
    return {"retiring": True}


@app.post("/lab/faults")
async def inject(request: Request):
    if MODE != "maa-replay":
        raise HTTPException(403, "fault_injection_disabled")
    if (await request.json()).get("storage_readonly"):
        db.execute("PRAGMA query_only=ON")
    return {"configured": True}


sock = socket.socket()
for attempt in range(30):
    try:
        sock.bind(("127.0.0.1", 20000 + secrets.randbelow(40000)))
        break
    except OSError as error:
        if error.errno not in (98, 10048):
            raise
else:
    raise RuntimeError("no local HTTP port available")
sock.listen(128)
uvicorn.Server(uvicorn.Config(app, log_level="warning", access_log=False)).run(sockets=[sock])

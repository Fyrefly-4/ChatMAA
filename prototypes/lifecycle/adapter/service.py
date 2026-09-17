"""仅限替身实验。没有 MaaCore、ADB 或真实设备入口。"""
import asyncio
import contextlib
import hmac
import json
import os
import secrets
from pathlib import Path
import socket
import sqlite3
import sys
import time
import uuid

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
import uvicorn


DATA = Path(os.environ["LAB_DATA"])
DATA.mkdir(parents=True, exist_ok=True)
INSTANCE = str(uuid.uuid4())
CONTROLLER = os.environ["LAB_CONTROLLER"]
TOKEN = os.environ["LAB_ADAPTER_TOKEN"]
LEASE = float(os.environ.get("LAB_LEASE_MS", "1500")) / 1000
DEADLINE = float(os.environ.get("LAB_STOP_DEADLINE_MS", "900")) / 1000
faults = json.loads(os.environ.get("LAB_PY_FAULTS", "{}"))

# OS 锁随句柄关闭释放；路径在同一模拟设备的所有实例间固定。
lock_path = Path(os.environ["LAB_DEVICE_LOCK"]).resolve()
lock_path.parent.mkdir(parents=True, exist_ok=True)
device_lock = open(lock_path, "a+b")
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
CREATE TABLE IF NOT EXISTS executions(id TEXT PRIMARY KEY, params TEXT NOT NULL,
  snapshot TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events(id TEXT NOT NULL, seq INTEGER NOT NULL,
  evidence TEXT NOT NULL, PRIMARY KEY(id, seq));
""")
active = {}
storage_failed = False
retiring = False
awaiting_ack = False
last_lease = time.monotonic()
retire_at = None


def trace(kind, **values):
    line = json.dumps({"kind": kind, "at": time.time(), **values})
    try:
        with open(DATA / "executor-trace.jsonl", "a", encoding="utf-8") as log:
            log.write(line + "\n")
    except OSError:
        pass
    try:
        print(line, flush=True)
    except OSError:
        # TS 退出会关闭 stdout 管道，日志失败不能使失联监督失效。
        pass


def checkpoint(name):
    if faults.get("crash") == name:
        trace("crash", point=name)
        os._exit(71)


def read(execution_id):
    row = db.execute("SELECT snapshot FROM executions WHERE id=?", (execution_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "unknown_execution")
    return json.loads(row[0])


def record(execution_id, kind, **changes):
    global storage_failed
    if faults.get("disk_full"):
        storage_failed = True
        raise sqlite3.OperationalError("injected storage failure")
    snapshot = read(execution_id)
    snapshot.update(changes)
    snapshot["seq"] += 1
    snapshot["updated_at"] = time.time()
    evidence = {"id": execution_id, "seq": snapshot["seq"], "kind": kind,
                "source_instance": INSTANCE, "snapshot": snapshot}
    db.execute("BEGIN IMMEDIATE")
    try:
        db.execute("UPDATE executions SET snapshot=? WHERE id=?", (json.dumps(snapshot), execution_id))
        db.execute("INSERT INTO events VALUES(?,?,?)", (execution_id, snapshot["seq"], json.dumps(evidence)))
        db.execute("COMMIT")
    except Exception:
        db.execute("ROLLBACK")
        storage_failed = True
        raise
    trace("evidence", evidence=evidence)
    return snapshot


for row in db.execute("SELECT id, snapshot FROM executions").fetchall():
    if json.loads(row["snapshot"])["state"] != "ended":
        record(row["id"], "recovered_uncertain", state="unknown", certainty="lower_bound",
               device="needs_check", reason="executor_restarted")


class Params(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    stage: str = Field(pattern=r"^1-7$")
    count: int = Field(ge=1, le=100)
    medicine: int = Field(ge=0, le=0)
    premium: int = Field(ge=0, le=0)


class Submission(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,80}$")
    params: Params


async def observe(kind, execution_id):
    # 独立实验驱动的观测端：持久化后才应答，不从任务表推算实际启动。
    port = int(os.environ["LAB_ORACLE_PORT"])
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write((json.dumps({"kind": kind, "id": execution_id,
                              "instance": INSTANCE, "at": time.time()}) + "\n").encode())
    await writer.drain()
    answer = await asyncio.wait_for(reader.readline(), 2)
    writer.close()
    await writer.wait_closed()
    if answer != b"ok\n":
        raise RuntimeError("oracle unavailable")


async def execute(execution_id, params, control):
    global storage_failed
    try:
        checkpoint("before_start")
        await observe("start", execution_id)
        checkpoint("after_start")
        record(execution_id, "started", state="running")
        while control["completed"] < params["count"]:
            await asyncio.sleep(float(faults.get("tick_ms", 180)) / 1000)
            if control["stop"]:
                await asyncio.sleep(0.25)
                await observe("stop", execution_id)
                record(execution_id, "stop_confirmed", state="ended", device="ready",
                       certainty="exact", reason="stopped")
                return
            control["completed"] += 1
            await observe("success", execution_id)
            checkpoint("before_success_record")
            record(execution_id, "success", confirmed=control["completed"])
            checkpoint("after_success_record")
            if faults.get("fail_after") == control["completed"]:
                await observe("stop", execution_id)
                record(execution_id, "failed", state="ended", device="ready", certainty="exact",
                       reason="simulated_failure")
                return
        await observe("stop", execution_id)
        record(execution_id, "completed", state="ended", device="ready", certainty="exact",
               reason="target_reached")
    except sqlite3.Error:
        storage_failed = True
        # 模拟执行循环已返回，不再产生动作；持久结果仍保留未知。
        await observe("stop", execution_id)
        trace("storage_failed", id=execution_id)
    except Exception as error:
        trace("executor_error", id=execution_id, error=type(error).__name__)
    finally:
        active.pop(execution_id, None)


async def deliver_stop(execution_id):
    control = active.get(execution_id)
    if control:
        if faults.get("block_stop"):
            # 模拟阻塞的 native 调用，放入工作线程，保持 HTTP 和监督循环可运行。
            await asyncio.to_thread(time.sleep, 60)
        control["stop"] = True


def request_stop(execution_id):
    try:
        snapshot = read(execution_id)
        if snapshot["state"] != "ended":
            record(execution_id, "stop_requested", state="stopping", device="occupied")
    except sqlite3.Error:
        pass
    asyncio.create_task(deliver_stop(execution_id))


def retire(reason, await_ack=False):
    global retiring, retire_at, awaiting_ack
    if not retiring:
        retiring = True
        awaiting_ack = await_ack
        retire_at = time.monotonic()
        trace("retiring", reason=reason)
        for execution_id in list(active):
            request_stop(execution_id)


async def supervise():
    while True:
        await asyncio.sleep(0.05)
        if time.monotonic() - last_lease > LEASE:
            retire("lease_expired")
        if retiring:
            if not active and not awaiting_ack:
                trace("exit", reason="retired")
                os._exit(0)
            if time.monotonic() - retire_at > DEADLINE:
                if not active:
                    trace("final_handoff_expired")
                    os._exit(0)
                trace("forced_self_exit", reason="stop_deadline")
                os._exit(72)


@contextlib.asynccontextmanager
async def lifespan(app):
    watcher = asyncio.create_task(supervise())
    trace("ready", instance=INSTANCE, controller=CONTROLLER, pid=os.getpid(), port=sock.getsockname()[1])
    yield
    watcher.cancel()


app = FastAPI(lifespan=lifespan)


@app.middleware("http")
async def authorize(request: Request, call_next):
    if (request.headers.get("origin") or
        not hmac.compare_digest(request.headers.get("x-control-token", ""), TOKEN) or
        request.headers.get("x-controller-id") != CONTROLLER or
        request.headers.get("x-instance-id") != INSTANCE):
        return JSONResponse({"error": "wrong_control_identity"}, status_code=403)
    if retiring and request.method != "GET" and request.url.path != "/shutdown":
        return JSONResponse({"error": "controller_retired"}, status_code=409)
    try:
        return await call_next(request)
    except sqlite3.Error:
        return JSONResponse({"error": "storage_unavailable"}, status_code=503)


@app.get("/health")
async def health():
    return {"instance": INSTANCE, "controller": CONTROLLER, "storage_failed": storage_failed,
            "retiring": retiring, "active": list(active)}


@app.post("/lease")
async def lease():
    global last_lease
    # 超时后的迟到续期不能重新获得控制。
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
    if storage_failed or faults.get("disk_full"):
        raise HTTPException(503, "storage_unavailable")
    if active or any(json.loads(r[0])["device"] != "ready" for r in db.execute("SELECT snapshot FROM executions")):
        raise HTTPException(409, "device_busy_or_uncertain")
    checkpoint("before_accept")
    initial = {"id": body.id, "seq": 0, "state": "accepted", "confirmed": 0,
               "certainty": "lower_bound", "device": "occupied", "reason": None,
               "updated_at": time.time()}
    db.execute("INSERT INTO executions VALUES(?,?,?)", (body.id, canonical, json.dumps(initial)))
    record(body.id, "accepted")
    checkpoint("after_accept")
    control = {"stop": False, "completed": 0}
    active[body.id] = control
    asyncio.create_task(execute(body.id, params, control))
    if faults.pop("drop_response", False):
        await asyncio.sleep(3)
    return read(body.id)


@app.get("/executions/{execution_id}")
async def query(execution_id: str, after: int = 0):
    snapshot = read(execution_id)
    if storage_failed:
        snapshot.update(state="unknown", certainty="lower_bound", device="needs_check", reason="storage_failed")
    events = [json.loads(r[0]) for r in db.execute(
        "SELECT evidence FROM events WHERE id=? AND seq>? ORDER BY seq", (execution_id, after))]
    if faults.get("omit_seq"):
        events = [e for e in events if e["seq"] != faults["omit_seq"]]
    return {"snapshot": snapshot, "events": events, "instance": INSTANCE}


@app.post("/executions/{execution_id}/stop", status_code=202)
async def stop(execution_id: str):
    read(execution_id)
    request_stop(execution_id)
    return {"id": execution_id, "stop_requested": True}


@app.post("/reconcile")
async def reconcile():
    if active or storage_failed or faults.get("disk_full"):
        raise HTTPException(409, "not_ready")
    # 仅替身：无外部动作/子进程，持有设备锁且无执行协程足以确认不再操作。
    # 真实 MAA 必须重新实现此证据来源，不能复用这个判断。
    for row in db.execute("SELECT id, snapshot FROM executions").fetchall():
        snap = json.loads(row["snapshot"])
        if snap["device"] != "ready":
            record(row["id"], "fake_environment_checked", state="ended", device="ready",
                   certainty="lower_bound", reason="reconciled_unknown_count")
    return {"environment": "fake_only", "device": "ready"}


@app.post("/prepare-shutdown", status_code=202)
async def prepare_shutdown():
    retire("application_shutdown", await_ack=True)
    return {"retiring": True, "awaiting_final_ack": True}


@app.post("/shutdown", status_code=202)
async def shutdown():
    global awaiting_ack
    retire("application_shutdown")
    awaiting_ack = False
    return {"retiring": True}


@app.post("/lab/faults")
async def inject(request: Request):
    incoming = await request.json()
    faults.update(incoming)
    if incoming.get("storage_readonly"):
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

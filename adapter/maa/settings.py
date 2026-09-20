"""正式启动配置。读取和校验不连接游戏，也不加载 MaaCore。"""
from dataclasses import dataclass
import hashlib
import json
import os
import re
from pathlib import Path
import sys

REPOSITORY = Path(__file__).resolve().parents[2]
CORE_SHA256 = "295a7aa78f3245a2112924231119d81d65f0fc201f364fed8cf1fb1db62d4b9a"


@dataclass(frozen=True)
class Settings:
    mode: str
    data: Path
    controller: str
    token: str
    lease_ms: int = 10000
    stop_deadline_ms: int = 20000
    installation: Path | None = None
    hwnd: int | None = None
    connection: dict | None = None

    @classmethod
    def from_env(cls):
        raw = json.loads(os.environ["CHATMAA_ADAPTER_CONFIG"])
        raw["data"] = Path(raw["data"]).resolve()
        if raw.get("installation"):
            raw["installation"] = Path(raw["installation"]).resolve()
        result = cls(**raw)
        if result.mode not in ("maa-replay", "maa-live") or not result.controller or not result.token:
            raise ValueError("invalid Adapter configuration")
        if result.mode == "maa-live":
            wizard_run = (result.data.name == "data" and result.data.parent.name.startswith("run-")
                          and result.data.parent.parent == (REPOSITORY / ".artifacts/live-wizard").resolve())
            if sys.platform != "win32" or not (result.data == (REPOSITORY / ".artifacts/live").resolve() or wizard_run):
                raise ValueError("live requires Windows and the default or wizard run data directory")
            if not result.installation:
                raise ValueError("live requires installation")
            if result.connection is not None:
                c = result.connection
                if (not isinstance(c, dict) or set(c) != {"kind", "adb", "address", "config"}
                        or result.hwnd is not None or c.get("kind") != "mumu"
                        or c.get("config") != "MuMuEmulator12"
                        or not isinstance(c.get("adb"), str) or not Path(c["adb"]).is_file()
                        or not isinstance(c.get("address"), str)
                        or not re.fullmatch(r"127\.0\.0\.1:[0-9]{1,5}", c["address"])
                        or not 1 <= int(c["address"].split(":")[1]) <= 65535):
                    raise ValueError("invalid explicit MuMu connection")
            elif type(result.hwnd) is not int or result.hwnd <= 0:
                raise ValueError("desktop live requires hwnd")
            with (result.installation / "MaaCore.dll").open("rb") as stream:
                if hashlib.file_digest(stream, "sha256").hexdigest() != CORE_SHA256:
                    raise ValueError("MaaCore changed: verify version before use")
        return result

    def lock_paths(self):
        if self.mode == "maa-replay":
            return [self.data / "device.lock"]
        paths = [REPOSITORY / ".artifacts/device.lock"]
        # While the historical CLI remains in this checkout, hold its lock too.
        # No experimental code/configuration is loaded; standalone formal code needs only the first lock.
        legacy = REPOSITORY / "prototypes/maa"
        if legacy.is_dir():
            paths.append(legacy / ".artifacts/device.lock")
        return paths


class DeviceLocks:
    def __init__(self, paths):
        self.files = []
        try:
            for path in paths:
                path.parent.mkdir(parents=True, exist_ok=True)
                stream = path.open("a+b")
                self.files.append(stream)
                if os.fstat(stream.fileno()).st_size == 0:
                    stream.write(b"0")
                    stream.flush()
                stream.seek(0)
                if sys.platform == "win32":
                    import msvcrt
                    msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BaseException:
            self.close()
            raise

    def close(self):
        for stream in self.files:
            stream.close()
        self.files.clear()

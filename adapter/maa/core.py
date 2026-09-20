"""Windows MaaCore 公共 C ABI 的最小封装；不导入安装目录中的 GUI 配置。"""
import ctypes
import json
import os
from pathlib import Path
import threading
import time
from resources import resource_roots


class ResourceLoadError(RuntimeError):
    """资源加载失败；发生在创建自动化实例之前。"""


class Core:
    def __init__(self, installation: Path, output: Path, incremental=None, quiet_callbacks=False, platform="desktop"):
        # 与官方 WPF GUI 的 system DPI 声明一致，在 native 创建线程/窗口前设置。
        user = ctypes.WinDLL("user32", use_last_error=True)
        user.GetThreadDpiAwarenessContext.restype = ctypes.c_void_p
        user.GetAwarenessFromDpiAwarenessContext.argtypes = [ctypes.c_void_p]
        user.GetAwarenessFromDpiAwarenessContext.restype = ctypes.c_int
        user.SetProcessDPIAware.restype = ctypes.c_int
        before_dpi = user.GetAwarenessFromDpiAwarenessContext(user.GetThreadDpiAwarenessContext())
        if before_dpi == 0 and not user.SetProcessDPIAware():
            raise RuntimeError(f"SetProcessDPIAware failed: {ctypes.get_last_error()}")
        after_dpi = user.GetAwarenessFromDpiAwarenessContext(user.GetThreadDpiAwarenessContext())
        if after_dpi != 1:
            raise RuntimeError(f"预期与官方 GUI 一致的 system DPI awareness，实际为 {after_dpi}")
        runtime = {"dpi_awareness_before": before_dpi, "dpi_awareness_after": after_dpi,
                   "system_dpi": user.GetDpiForSystem()}
        self.output = output.resolve()
        self.output.mkdir(parents=True, exist_ok=True)
        self.events = []
        self.event_lock = threading.Lock()
        self.handle = None
        self.callback_error = None
        self.quiet_callbacks = quiet_callbacks
        # Core 内部的 LoadLibrary 也需要找到同目录控制组件；仅影响本进程。
        os.environ["PATH"] = str(installation.resolve()) + os.pathsep + os.environ.get("PATH", "")
        self.dll_directory = os.add_dll_directory(str(installation.resolve()))
        self.lib = ctypes.WinDLL(str(installation.resolve() / "MaaCore.dll"))
        pointer, text, boolean = ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint8
        integer, size = ctypes.c_int32, ctypes.c_uint64
        signatures = {
            "AsstGetVersion": (text, []),
            "AsstSetUserDir": (boolean, [text]),
            "AsstLoadResource": (boolean, [text]),
            "AsstCreateEx": (pointer, [pointer, pointer]),
            "AsstDestroy": (None, [pointer]),
            "AsstAsyncAttachWindow": (integer, [pointer, pointer, size, size, size, boolean]),
            "AsstAsyncConnect": (integer, [pointer, text, text, text, boolean]),
            "AsstConnected": (boolean, [pointer]),
            "AsstAsyncScreencap": (integer, [pointer, boolean]),
            "AsstGetImage": (size, [pointer, pointer, size]),
            "AsstAppendTask": (integer, [pointer, text, text]),
            "AsstStart": (boolean, [pointer]),
            "AsstStop": (boolean, [pointer]),
            "AsstRunning": (boolean, [pointer]),
        }
        for name, (result, args) in signatures.items():
            function = getattr(self.lib, name)
            function.restype, function.argtypes = result, args
        self.version = self.lib.AsstGetVersion().decode("utf-8")
        if not self.lib.AsstSetUserDir(str(self.output).encode("utf-8")):
            raise RuntimeError("AsstSetUserDir failed")
        roots = resource_roots(installation, platform)
        for resource_root in roots:
            if not self.lib.AsstLoadResource(str(resource_root).encode("utf-8")):
                self.dll_directory.close()
                raise ResourceLoadError(f"AsstLoadResource failed: {resource_root}")
        if incremental and not self.lib.AsstLoadResource(str(Path(incremental).resolve()).encode("utf-8")):
            self.dll_directory.close()
            raise ResourceLoadError("incremental resource load failed")
        callback_type = ctypes.WINFUNCTYPE(None, integer, text, pointer)
        self.callback = callback_type(self._callback)
        self.handle = self.lib.AsstCreateEx(self.callback, None)
        if not self.handle:
            raise RuntimeError("AsstCreateEx failed")
        self.write("core_loaded", version=self.version)
        self.write("host_runtime", **runtime, resource_roots=[str(path) for path in roots])

    def write(self, kind, **values):
        event = {"at": time.time(), "monotonic": time.monotonic(), "kind": kind, **values}
        with self.event_lock:
            self.events.append(event)
            with (self.output / "events.jsonl").open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(event, ensure_ascii=False) + "\n")
                stream.flush()
                os.fsync(stream.fileno())
        if kind != "callback" or not self.quiet_callbacks:
            try:
                print(json.dumps(event, ensure_ascii=False), flush=True)
            except OSError:
                pass
        return event

    def _callback(self, message, raw, _arg):
        try:
            original = (raw or b"").decode("utf-8", errors="replace")
            try:
                details = json.loads(original) if original else None
            except json.JSONDecodeError:
                details = None
            self.write("callback", message=message, details=details, raw=original)
        except BaseException as error:
            # 不让 Python 异常穿过 native 回调边界；主循环核对记录完整性。
            self.callback_error = repr(error)

    def attach(self, hwnd: int, screencap=16, mouse=128, keyboard=2):
        self.write("attach_requested", hwnd=hwnd, screencap=screencap, mouse=mouse, keyboard=keyboard)
        call_id = self.lib.AsstAsyncAttachWindow(self.handle, hwnd, screencap, mouse, keyboard, True)
        connected = bool(self.lib.AsstConnected(self.handle))
        self.write("attach_returned", call_id=call_id, connected=connected)
        if not connected:
            raise RuntimeError("window connection failed; inspect raw callback evidence")

    def connect(self, connection):
        self.write("adb_connect_requested", address=connection["address"], config=connection["config"])
        call_id = self.lib.AsstAsyncConnect(self.handle, connection["adb"].encode("utf-8"),
                                          connection["address"].encode("utf-8"),
                                          connection["config"].encode("utf-8"), True)
        connected = bool(self.lib.AsstConnected(self.handle))
        self.write("adb_connect_returned", call_id=call_id, connected=connected)
        if call_id <= 0 or not connected:
            raise RuntimeError("ADB connection failed; inspect raw callback evidence")

    def screenshot(self, filename="window.png"):
        call_id = self.lib.AsstAsyncScreencap(self.handle, True)
        buffer = ctypes.create_string_buffer(32 * 1024 * 1024)
        received = int(self.lib.AsstGetImage(self.handle, buffer, len(buffer)))
        if received <= 0 or received > len(buffer):
            raise RuntimeError(f"screenshot unavailable: {received}")
        (self.output / filename).write_bytes(buffer.raw[:received])
        self.write("screenshot_saved", filename=filename, bytes=received, call_id=call_id)

    def close(self):
        if self.handle:
            self.lib.AsstDestroy(self.handle)
            self.handle = None
            self.write("destroy_returned")


def window_identity(hwnd: int):
    from ctypes import wintypes
    user = ctypes.WinDLL("user32", use_last_error=True)
    user.IsWindow.argtypes, user.IsWindow.restype = [wintypes.HWND], wintypes.BOOL
    user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    if not user.IsWindow(hwnd):
        raise RuntimeError("window no longer exists")
    title = ctypes.create_unicode_buffer(512)
    user.GetWindowTextW(hwnd, title, len(title))
    pid = wintypes.DWORD()
    user.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    if title.value != "明日方舟":
        raise RuntimeError("window title is not the selected Arknights client")
    return {"hwnd": hwnd, "pid": pid.value, "title": title.value}

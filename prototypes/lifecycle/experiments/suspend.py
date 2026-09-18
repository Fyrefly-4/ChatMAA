"""实验专用：持有目标进程句柄，挂起整个替身/TS；stdin 关闭必定恢复。

NtSuspendProcess/NtResumeProcess 是 Windows native API，仅用于故障注入，
不是产品监督方案。PID 只由驱动根据本次启动的子进程传入。
"""
import ctypes
from ctypes import wintypes
import json
import sys

if sys.platform != "win32":
    raise SystemExit("此故障注入器仅验证 Windows")

kernel = ctypes.WinDLL("kernel32", use_last_error=True)
native = ctypes.WinDLL("ntdll")
kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel.OpenProcess.restype = wintypes.HANDLE
kernel.CloseHandle.argtypes = [wintypes.HANDLE]
native.NtSuspendProcess.argtypes = [wintypes.HANDLE]
native.NtSuspendProcess.restype = wintypes.LONG
native.NtResumeProcess.argtypes = [wintypes.HANDLE]
native.NtResumeProcess.restype = wintypes.LONG
handle = kernel.OpenProcess(0x0800, False, int(sys.argv[1]))
if not handle:
    raise ctypes.WinError(ctypes.get_last_error())
try:
    status = native.NtSuspendProcess(handle)
    if status != 0:
        raise RuntimeError(f"NtSuspendProcess status={status}")
    print(json.dumps({"suspended": int(sys.argv[1])}), flush=True)
    try:
        sys.stdin.readline()
    finally:
        native.NtResumeProcess(handle)
finally:
    kernel.CloseHandle(handle)

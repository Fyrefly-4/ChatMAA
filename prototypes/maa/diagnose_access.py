"""只读检查当前进程与指定游戏进程的 Windows 完整性等级。"""
import ctypes
from ctypes import wintypes
import json
import os
import sys

k = ctypes.WinDLL("kernel32", use_last_error=True)
a = ctypes.WinDLL("advapi32", use_last_error=True)
k.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
k.OpenProcess.restype = wintypes.HANDLE
k.CloseHandle.argtypes = [wintypes.HANDLE]
a.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
a.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
a.GetSidSubAuthorityCount.argtypes = [wintypes.LPVOID]
a.GetSidSubAuthorityCount.restype = ctypes.POINTER(ctypes.c_ubyte)
a.GetSidSubAuthority.argtypes = [wintypes.LPVOID, wintypes.DWORD]
a.GetSidSubAuthority.restype = ctypes.POINTER(wintypes.DWORD)


def integrity(pid):
    process = k.OpenProcess(0x1000, False, pid)
    if not process:
        return {"pid": pid, "error": ctypes.get_last_error()}
    token = wintypes.HANDLE()
    try:
        if not a.OpenProcessToken(process, 8, ctypes.byref(token)):
            return {"pid": pid, "error": ctypes.get_last_error()}
        needed = wintypes.DWORD()
        a.GetTokenInformation(token, 25, None, 0, ctypes.byref(needed))
        buffer = ctypes.create_string_buffer(needed.value)
        if not a.GetTokenInformation(token, 25, buffer, len(buffer), ctypes.byref(needed)):
            return {"pid": pid, "error": ctypes.get_last_error()}
        sid = ctypes.cast(buffer, ctypes.POINTER(wintypes.LPVOID))[0]
        count = a.GetSidSubAuthorityCount(sid)[0]
        level = a.GetSidSubAuthority(sid, count - 1)[0]
        return {"pid": pid, "integrity_rid": level,
                "level": {0x1000: "low", 0x2000: "medium", 0x3000: "high", 0x4000: "system"}.get(level, "other")}
    finally:
        if token:
            k.CloseHandle(token)
        k.CloseHandle(process)


print(json.dumps({"current": integrity(os.getpid()), "game": integrity(int(sys.argv[1]))}))

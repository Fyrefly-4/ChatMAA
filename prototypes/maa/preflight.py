"""只加载资源、绑定指定游戏窗口并截图；不入队或开始 Fight。"""
import argparse
import hashlib
import json
from pathlib import Path
import platform

from core import Core, window_identity


parser = argparse.ArgumentParser()
parser.add_argument("--installation", type=Path, required=True)
parser.add_argument("--hwnd", type=int, required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
identity = window_identity(args.hwnd)
args.output.mkdir(parents=True, exist_ok=True)
facts = {
    "platform": platform.platform(), "python": platform.python_version(),
    "window": identity,
    "core_sha256": hashlib.file_digest((args.installation / "MaaCore.dll").open("rb"), "sha256").hexdigest(),
    "resource_version": json.loads((args.installation / "resource/version.json").read_text(encoding="utf-8")),
    "connection": {"screencap": "PrintWindow", "mouse": "SendMessageWithWindowPos", "keyboard": "SendMessage"},
    "battle_started": False,
}
core = Core(args.installation, args.output)
try:
    facts["core_version"] = core.version
    core.attach(args.hwnd)
    core.screenshot()
    facts["preflight"] = "connected_and_captured"
finally:
    core.close()
    (args.output / "environment.json").write_text(json.dumps(facts, ensure_ascii=False, indent=2), encoding="utf-8")

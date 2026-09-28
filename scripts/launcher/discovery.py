"""用户启动器的只读文件／进程发现；迁自 D2 本地向导，不加载 Core，不连接或操作游戏。"""
import json
from pathlib import Path
import re
import subprocess
import xml.etree.ElementTree as ET

ADB_NAMES = {'adb.exe', 'adb_server.exe'}


def running_paths():
    script = "[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^(MuMu|MaaWpfGui)' } | ForEach-Object { $_.Path } | ConvertTo-Json -Compress"
    try:
        result = subprocess.run(['powershell.exe', '-NoProfile', '-Command', script], capture_output=True,
                                timeout=10, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        value = json.loads(result.stdout.decode('utf-8-sig'))
        return [value] if isinstance(value, str) else [v for v in value or [] if isinstance(v, str)]
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return []


def discover(old, paths):
    installations, adbs, roots = set(), set(), set()
    if old.get('installation'):
        path = Path(old['installation']).resolve()
        if (path / 'MaaCore.dll').is_file():
            installations.add(str(path))
    sources = [Path(p).resolve() for p in paths if p]
    if old.get('adb'):
        sources.append(Path(old['adb']).resolve())
    for source in sources:
        parent = source.parent
        if (parent / 'MaaCore.dll').is_file():
            installations.add(str(parent))
        for relative in ('adb.exe', '../vmonitor/bin/adb_server.exe', '../../../nx_main/adb.exe',
                         '../../MuMu/emulator/nemu/vmonitor/bin/adb_server.exe'):
            candidate = (parent / relative).resolve()
            if candidate.is_file():
                adbs.add(str(candidate))
        if source.name.lower() in ADB_NAMES and source.is_file():
            adbs.add(str(source))
        for root in list(source.parents)[:4]:
            if (root / 'vms').is_dir():
                roots.add(root)
    addresses, versions = {}, {}
    for root in sorted(roots):
        try:
            data = json.loads((root / 'configs/install_config.json').read_text(encoding='utf-8-sig'))
            versions[str(root)] = data.get('product', {}).get('version', 'unknown')
        except (OSError, ValueError):
            pass
        for file in sorted((root / 'vms').glob('*/*.nemu')):
            try:
                for node in ET.parse(file).iter():
                    if node.tag.rsplit('}', 1)[-1] != 'Forwarding' or node.get('name') != 'ADB_PORT':
                        continue
                    port = node.get('hostport', '')
                    if node.get('hostip') == '127.0.0.1' and re.fullmatch(r'[0-9]{1,5}', port) and 0 < int(port) < 65536:
                        addresses['127.0.0.1:' + port] = file.parent.name
            except (OSError, ET.ParseError):
                continue
    return {'installations': sorted(installations), 'adbs': sorted(adbs), 'addresses': addresses, 'versions': versions}


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--config')
    parser.add_argument('--adb')
    args = parser.parse_args()
    old = {}
    if args.config and Path(args.config).is_file():
        raw = json.loads(Path(args.config).read_text(encoding='utf-8-sig'))
        base = Path(args.config).resolve().parent
        for key, value in [('installation', raw.get('installation')), ('adb', raw.get('connection', {}).get('adb'))]:
            if value:
                old[key] = str((base / value).resolve())
    if args.adb:
        old['adb'] = args.adb
    result = discover(old, running_paths())
    # Keep the ADB associated with its installation; never combine unrelated installs.
    instances = []
    for adb in result['adbs']:
        scoped = discover({'adb': adb}, [])
        for address, name in scoped['addresses'].items():
            instances.append({'name': name, 'address': address, 'adb': adb})
    result['instances'] = instances
    print(json.dumps(result, ensure_ascii=True))


if __name__ == '__main__':
    main()

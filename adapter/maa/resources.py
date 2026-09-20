"""记录实际资源内容及执行映射依据；仅文件读取，不加载或连接 MaaCore。"""
import hashlib
import json


def resource_roots(installation, platform="desktop"):
    roots = [installation.resolve()]
    candidates = [installation / "cache"]
    if platform == "desktop":
        candidates.append(installation / "resource/platform_diff/PC")
    roots.extend(path.resolve() for path in candidates if (path / "resource").is_dir())
    return roots


def manifest(installation, platform):
    files = []
    for index, root in enumerate(resource_roots(installation, platform)):
        for path in sorted((root / "resource").rglob("*")):
            if not path.is_file():
                continue
            with path.open("rb") as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            files.append({"root": index, "path": path.relative_to(root).as_posix(), "sha256": digest})
    encoded = json.dumps(files, sort_keys=True).encode()
    return {"platform": platform, "roots": [str(p) for p in resource_roots(installation, platform)],
            "sha256": hashlib.sha256(encoded).hexdigest(), "files": files}


def verify_material(installation, platform, params):
    if params["kind"] != "fight_material":
        return
    items = {}
    for root in resource_roots(installation, platform):
        path = root / "resource/item_index.json"
        if path.is_file():
            index = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(index, dict):
                raise ValueError("material resource index must be an object")
            items.update(index)
    if params["item_id"] not in items:
        raise ValueError("material ID absent from installed resource index")

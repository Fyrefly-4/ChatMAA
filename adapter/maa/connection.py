"""连接与平台资源选择；不发现、启动或切换游戏实例。"""
from core import Core, window_identity


def create_core(settings, output, core_factory=Core, **kwargs):
    if settings.connection is not None:
        kwargs["platform"] = "mumu"
    return core_factory(settings.installation, output, **kwargs)


def connect_core(core, settings):
    if settings.connection is not None:
        core.connect(settings.connection)
    else:
        core.attach(settings.hwnd)


def target_identity(settings, identity=None):
    if settings.connection is not None:
        return {"kind": "mumu", "address": settings.connection["address"], "config": settings.connection["config"]}
    if identity is None:
        from core import window_identity as identity
    return identity(settings.hwnd)

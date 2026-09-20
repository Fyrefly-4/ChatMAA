"""由 TS 宿主管理的正式 Adapter 入口；启动不执行任务。"""
import socket
import uvicorn
from service import Controller, create_app
from settings import DeviceLocks, Settings


def main():
    settings = Settings.from_env()
    locks = DeviceLocks(settings.lock_paths())
    sock = socket.socket()
    try:
        # Let Windows choose an available port instead of hitting excluded ranges.
        sock.bind(("127.0.0.1", 0))
        sock.listen(128)
        control = Controller(settings)
        app = create_app(control, sock.getsockname()[1])
        uvicorn.Server(uvicorn.Config(app, log_level="warning", access_log=False)).run(sockets=[sock])
    finally:
        sock.close()
        locks.close()


if __name__ == "__main__":
    main()

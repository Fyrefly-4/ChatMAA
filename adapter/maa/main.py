"""由 TS 宿主管理的正式 Adapter 入口；启动不执行任务。"""
import secrets
import socket
import uvicorn
from service import Controller, create_app
from settings import DeviceLocks, Settings


def main():
    settings = Settings.from_env()
    locks = DeviceLocks(settings.lock_paths())
    sock = socket.socket()
    try:
        for _ in range(30):
            try:
                sock.bind(("127.0.0.1", 20000 + secrets.randbelow(40000)))
                break
            except OSError as error:
                if error.errno not in (98, 10048):
                    raise
        else:
            raise RuntimeError("no local HTTP port available")
        sock.listen(128)
        control = Controller(settings)
        app = create_app(control, sock.getsockname()[1])
        uvicorn.Server(uvicorn.Config(app, log_level="warning", access_log=False)).run(sockets=[sock])
    finally:
        sock.close()
        locks.close()


if __name__ == "__main__":
    main()

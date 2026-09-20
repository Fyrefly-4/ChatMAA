import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from connection import connect_core, create_core, target_identity
from core import Core
from settings import Settings, REPOSITORY, CORE_SHA256


class ConnectionTest(unittest.TestCase):
    def test_mumu_routes_without_window_identity_or_pc_resources(self):
        connection = {"kind": "mumu", "adb": "C:/MuMu/adb.exe", "address": "127.0.0.1:16384", "config": "MuMuEmulator12"}
        settings = Settings("maa-live", Path("."), "controller", "token", connection=connection)
        factory = Mock()
        core = create_core(settings, Path("output"), factory, quiet_callbacks=True)
        connect_core(core, settings)
        factory.assert_called_once_with(None, Path("output"), quiet_callbacks=True, platform="mumu")
        core.connect.assert_called_once_with(connection)
        core.attach.assert_not_called()
        identity = Mock(side_effect=AssertionError("must not inspect a desktop window"))
        self.assertEqual(target_identity(settings, identity)["address"], connection["address"])
        identity.assert_not_called()

    def test_adb_abi_and_failed_connection(self):
        core = object.__new__(Core)
        core.handle, core.lib, core.write = 123, Mock(), Mock()
        c = {"adb": "C:/目录/adb.exe", "address": "127.0.0.1:16384", "config": "MuMuEmulator12"}
        core.lib.AsstAsyncConnect.return_value = 7
        core.lib.AsstConnected.return_value = True
        core.connect(c)
        core.lib.AsstAsyncConnect.assert_called_once_with(123, c["adb"].encode(), b"127.0.0.1:16384", b"MuMuEmulator12", True)
        core.lib.AsstConnected.return_value = False
        with self.assertRaises(RuntimeError): core.connect(c)

    def test_configuration_rejects_ambiguous_or_invalid_device(self):
        with tempfile.TemporaryDirectory() as tmp:
            installation = Path(tmp)
            (installation / "MaaCore.dll").write_bytes(b"fixture")
            adb = installation / "adb.exe"
            adb.touch()
            connection = {"kind": "mumu", "adb": str(adb), "address": "127.0.0.1:16384", "config": "MuMuEmulator12"}
            raw = {"mode": "maa-live", "data": str(REPOSITORY / ".artifacts/live"), "controller": "c", "token": "t",
                   "installation": tmp, "connection": connection}
            def load(value):
                with patch.dict(os.environ, CHATMAA_ADAPTER_CONFIG=json.dumps(value)), patch("settings.sys.platform", "win32"), \
                        patch("settings.hashlib.file_digest") as digest:
                    digest.return_value.hexdigest.return_value = CORE_SHA256
                    return Settings.from_env()
            self.assertEqual(load(raw).connection, connection)
            for invalid in [{**raw, "hwnd": 1}, {**raw, "connection": []},
                            *[{**raw, "connection": {**connection, "address": address}}
                              for address in ["127.0.0.1:0", "127.0.0.1:65536", "localhost:16384", "127.0.0.1:1;cmd"]]]:
                with self.subTest(invalid=invalid), self.assertRaises(ValueError): load(invalid)


if __name__ == "__main__":
    unittest.main()

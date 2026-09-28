import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('launcher_discovery', Path(__file__).with_name('discovery.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class DiscoveryTests(unittest.TestCase):
    def test_player_path_is_repaired_and_legacy_port_excluded(self):
        with tempfile.TemporaryDirectory(prefix='chatmaa discovery ') as directory:
            root = Path(directory)
            (root / 'shell').mkdir()
            (root / 'shell/MuMuPlayer.exe').touch()
            (root / 'shell/adb.exe').touch()
            vm = root / 'vms/instance-0'
            vm.mkdir(parents=True)
            (vm / 'instance.nemu').write_text('<root><Forwarding name="ADB_PORT" hostip="127.0.0.1" hostport="16384"/><Forwarding name="ADB_PORT_OLD" hostip="127.0.0.1" hostport="7555"/></root>')
            found = module.discover({'adb': str(root / 'shell/MuMuPlayer.exe')}, [])
            self.assertEqual(found['adbs'], [str(root / 'shell/adb.exe')])
            self.assertEqual(found['addresses'], {'127.0.0.1:16384': 'instance-0'})

    def test_multiple_instances_remain_available_and_bad_files_do_not_abort(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'shell').mkdir()
            (root / 'shell/adb.exe').touch()
            for index, port in enumerate([16384, 16416]):
                vm = root / f'vms/instance-{index}'
                vm.mkdir(parents=True)
                (vm / 'config.nemu').write_text(f'<root><Forwarding name="ADB_PORT" hostip="127.0.0.1" hostport="{port}"/></root>')
            (root / 'vms/instance-0/broken.nemu').write_text('not XML')
            found = module.discover({}, [str(root / 'shell/MuMuPlayer.exe')])
            self.assertEqual(set(found['addresses']), {'127.0.0.1:16384', '127.0.0.1:16416'})

    def test_nonlocal_or_invalid_ports_are_ignored_and_saved_maa_is_reused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'MaaCore.dll').touch()
            (root / 'adb.exe').touch()
            vm = root / 'vms/instance-0'
            vm.mkdir(parents=True)
            (vm / 'config.nemu').write_text('<root><Forwarding name="ADB_PORT" hostip="0.0.0.0" hostport="16384"/><Forwarding name="ADB_PORT" hostip="127.0.0.1" hostport="65536"/></root>')
            found = module.discover({'installation': directory, 'adb': str(root / 'adb.exe')}, [])
            self.assertEqual(found['addresses'], {})
            self.assertEqual(found['installations'], [str(root)])

if __name__ == '__main__':
    unittest.main()

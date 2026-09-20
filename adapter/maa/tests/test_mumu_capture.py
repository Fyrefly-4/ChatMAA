"""已采集回调的离线解释回归；不连接模拟器。异常样例均为显式注入。"""
import copy
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from execution import projection, execute_operation
from settings import Settings
from test_operations_native import OperationHarness

FIXTURES = Path(__file__).resolve().parents[1] / 'fixtures/d2-mumu'


def load(name):
    return json.loads((FIXTURES / (name + '.json')).read_text(encoding='utf-8'))


class MuMuCaptureTest(unittest.TestCase):
    def test_recorded_inventory_sequence_requires_completion_and_stop(self):
        sample = load('scan')
        for end in range(len(sample['events'])):
            value = projection(sample['events'][:end], 7, sample['params'], True)
            self.assertFalse(value['inventory_result']['complete'])
        value = projection(sample['events'], 7, sample['params'], True)
        self.assertEqual(value['inventory_result']['items'], {'2001': 5, '30012': 72})
        self.assertEqual(value['inventory_result']['missing_items'], 'unknown')
        self.assertTrue(value['inventory_result']['complete'])
        self.assertFalse(projection(sample['events'], 7, sample['params'], False)['inventory_result']['complete'])

    def test_recorded_single_series_without_cur_times_counts_once(self):
        for name in ('count', 'material'):
            with self.subTest(name=name):
                sample = load(name)
                drops = next(e for e in sample['events'] if e['details'].get('what') == 'StageDrops')
                self.assertNotIn('cur_times', drops['details']['details'])
                value = projection(sample['events'], 7, sample['params'], True)
                self.assertEqual(value['count_result']['value'], 1)
                self.assertEqual(value['count_result']['certainty'], 'exact')
                self.assertEqual(value['material_result']['items']['30012'], 1)
                self.assertEqual(value['material_result']['certainty'], 'exact')
                self.assertTrue(value['threshold_reached'])
                self.assertEqual(value['unsettled_cycles'], 0)

    def test_recorded_stop_preserves_started_but_unsettled_cycle(self):
        sample = load('stop')
        value = projection(sample['events'], 7, sample['params'], True)
        self.assertEqual(value['started_cycles'], 1)
        self.assertEqual(value['unsettled_cycles'], 1)
        self.assertEqual(value['count_result']['value'], 0)
        self.assertEqual(value['count_result']['certainty'], 'lower_bound')
        self.assertFalse(value['threshold_reached'])

    def test_injected_missing_or_unknown_drops_deliver_stop_in_native_loop(self):
        # Keep the observed ordering, but mutate the evidence deliberately. This is not a live OCR fault.
        for fault in ('missing', 'unknown'):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as tmp:
                sample = load('material')
                events = copy.deepcopy(sample['events'])
                for e in events: e['details']['taskid'] = 1  # Native harness assigns Fight task 1.
                if fault == 'missing':
                    events = [e for e in events if e['details'].get('what') != 'StageDrops']
                else:
                    drops = next(e for e in events if e['details'].get('what') == 'StageDrops')
                    drops['details']['details']['drops'][0]['dropType'] = 'UNKNOWN_DROP'
                # The worker is still running when it observes the failed settlement.
                events = [e for e in events if e['message'] != 10002]
                harness = OperationHarness()
                stopped = threading.Event()
                calls = []
                running_reads = 0
                def factory(*args, **kwargs):
                    core = harness.core(*args, **kwargs)
                    original_start = core.AsstStart
                    def start(handle):
                        result = original_start(handle)
                        if core.kind == 'Fight': core.events = events
                        return result
                    def stop(handle):
                        calls.append(core.kind)
                        stopped.set()
                        return True
                    core.AsstStart = start
                    core.AsstStop = stop
                    def running(handle):
                        nonlocal running_reads
                        if core.kind != 'Fight' or stopped.is_set(): return False
                        running_reads += 1
                        # Bound a broken test without turning missing stop into a passing result.
                        return running_reads < 10
                    core.AsstRunning = running
                    return core
                settings = Settings('maa-live', Path(tmp), 'c', 't', installation=Path(tmp),
                    connection={'kind': 'mumu', 'adb': 'fixture', 'address': '127.0.0.1:16384', 'config': 'MuMuEmulator12'})
                result = execute_operation(settings, {'id': 'injected', 'params': sample['params']},
                    threading.Event(), lambda *args: None, Path(tmp), factory)
                self.assertEqual(calls, ['Fight'])
                self.assertEqual(result['reason'], 'execution_or_evidence_error')
                self.assertTrue(result['automation_stopped'])
                self.assertFalse(result['environment']['ready'])
                self.assertNotEqual(result['material_result']['certainty'], 'exact')
                self.assertEqual(len([k for k, _ in harness.calls if k == 'Fight']), 1)
                self.assertEqual(len([k for k, _ in harness.calls if k == 'Custom']), 1)


if __name__ == '__main__':
    unittest.main()

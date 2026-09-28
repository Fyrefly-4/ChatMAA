import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from service import Controller
from settings import Settings


class CompletionFactsTest(unittest.TestCase):
    def test_normal_completion_requires_chain_stop_and_no_errors(self):
        cases = [({}, True), ({'task_chain_completed': False}, False),
                 ({'errors': ['failed']}, False), ({'automation_stopped': False}, False),
                 ({'runtime_error': 'failed'}, False), ({'reason': 'user_stop'}, False)]
        for change, expected in cases:
            with self.subTest(change=change), tempfile.TemporaryDirectory() as directory:
                controller = Controller(Settings('maa-replay', Path(directory), 'controller', 'token'))
                try:
                    controller.db.execute('INSERT INTO executions VALUES(?,?,?)', ('one', '{}', json.dumps({'id': 'one', 'seq': 0})))
                    controller.active['one'] = {'stop': threading.Event()}
                    controller.receive('one', 'operation_finished', {
                        'automation_stopped': True, 'reason': 'normal', 'task_chain_completed': True,
                        'count_result': {'value': 3, 'certainty': 'exact', 'issues': []},
                        'started_cycles': 3, 'unsettled_cycles': 0, **change})
                    self.assertEqual(controller.read('one')['normal_completed'], expected)
                finally:
                    controller.db.close()

"""独立验证 Adapter HTTP 边界，不依赖尚未加入的 Backend。"""
import json
import os
from pathlib import Path
import queue
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen


class ControlHTTPTest(unittest.TestCase):
    def test_acceptance_idempotency_persistence_and_shutdown_without_backend(self):
        with tempfile.TemporaryDirectory() as temporary:
            data = Path(temporary)
            config = {"mode": "maa-replay", "data": temporary, "controller": "test-controller",
                      "token": "test-token", "lease_ms": 10000, "stop_deadline_ms": 3000}
            entry = Path(__file__).resolve().parents[1] / "main.py"
            process = subprocess.Popen([sys.executable, "-u", str(entry)],
                                       env={**os.environ, "CHATMAA_ADAPTER_CONFIG": json.dumps(config)},
                                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            lines = queue.Queue()
            reader = threading.Thread(target=lambda: [lines.put(line) for line in process.stdout], daemon=True)
            reader.start()
            try:
                ready = json.loads(lines.get(timeout=8))
                self.assertEqual(ready["kind"], "ready")
                headers = {"content-type": "application/json", "x-control-token": "test-token",
                           "x-controller-id": "test-controller", "x-instance-id": ready["instance"]}

                def call(path, body=None):
                    request = Request(f'http://127.0.0.1:{ready["port"]}{path}', headers=headers,
                                      data=None if body is None else json.dumps(body).encode())
                    with urlopen(request, timeout=3) as response:
                        return json.load(response)

                operation = {"id": "one", "params": {"stage": "1-7", "count": 1, "medicine": 0, "premium": 0}}
                call('/executions', operation)
                call('/executions', operation)
                with self.assertRaises(HTTPError) as conflict:
                    call('/executions', {**operation, "params": {**operation["params"], "count": 2}})
                self.assertEqual(conflict.exception.code, 409)
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    result = call('/executions/one')
                    if result["snapshot"]["state"] == "ended":
                        break
                    time.sleep(0.03)
                snapshot = result["snapshot"]
                self.assertEqual(snapshot["state"], "ended")
                self.assertEqual(snapshot["confirmed"], 1)
                self.assertEqual(snapshot["certainty"], "exact")
                self.assertTrue(snapshot["automation_stopped"])
                self.assertEqual(len((data / 'worker-audit.jsonl').read_text().splitlines()), 1)
                self.assertEqual(call(f'/executions/one?after={snapshot["seq"]}')["events"], [])
                call('/prepare-shutdown', {})
                self.assertEqual(call('/executions/one')["snapshot"], snapshot)
                call('/shutdown', {})
                self.assertEqual(process.wait(timeout=5), 0)
                connection = sqlite3.connect(f'{(data / "executor.sqlite").as_uri()}?mode=ro', uri=True)
                try:
                    saved = json.loads(connection.execute('SELECT snapshot FROM executions WHERE id=?', ('one',)).fetchone()[0])
                    self.assertEqual(saved, snapshot)
                finally:
                    connection.close()
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)
                reader.join(timeout=2)
                process.stdout.close()


if __name__ == '__main__':
    unittest.main()

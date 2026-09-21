import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { repository } from '../src/config.ts';
import { goalResult } from '../src/business/goals.ts';
import type { TaskView } from '../src/task-contract.ts';

test('D2 MuMu 脱敏历史回调经正式 Python 解释器到 D3 目标结果；不是新实机运行', () => {
  const script = `import json,sys,pathlib
sys.path.insert(0,str(pathlib.Path('adapter/maa').resolve()))
from execution import projection
values={}
for name in ('scan','count','material','stop'):
    sample=json.loads(pathlib.Path('adapter/maa/fixtures/d2-mumu',name+'.json').read_text(encoding='utf-8'))
    values[name]={'params':sample['params'],'result':projection(sample['events'],7,sample['params'],True)}
print(json.dumps(values))`;
  const values = JSON.parse(execFileSync(resolve(repository, 'adapter/maa/.venv/Scripts/python.exe'), ['-c', script],
    { cwd: repository, encoding: 'utf8', windowsHide: true, timeout: 10000 }));
  assert.equal(values.scan.result.inventory_result.items['30012'], 72);
  function task(name: string): TaskView {
    return { ...values[name].result, params: values[name].params, id: name, seq: 1, cursor: 1, gap: false,
      state: 'ended', automation_stopped: true, reason: name === 'stop' ? 'user_stop' : 'normal',
      evidence_source: 'D2_sanitized_capture_offline_projection', sync: { available: true, last_success_at: 1, reason: null } };
  }
  assert.equal(goalResult(task('count'), { kind: 'count', quantity: 1 }).amount.value, 1);
  assert.equal(goalResult(task('material'), { kind: 'inventory', quantity: 73, itemId: '30012' }, undefined, 72).target, 'achieved');
  const stopped = goalResult(task('stop'), { kind: 'count', quantity: 2 });
  assert.equal(stopped.amount.certainty, 'lower_bound'); assert.equal(stopped.remaining, null);
  assert.equal(stopped.target, 'uncertain'); assert.equal(stopped.process, 'stopped');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorize } from '../src/agent/policy.ts';
const params = (count = 10) => ({ stage: '1-7', count, medicine: 0, premium: 0 });

test('full expression permission preserves count and refuses conditions instead of dropping them', () => {
  for (const [text, count] of [['帮我刷 1-7 十次', 10], ['请刷1-7 2147483647次，不吃药不碎石', 2147483647], ['刷1-7二十三次', 23]] as const) {
    assert.deepEqual(authorize(text), { action: 'submit', params: params(count) });
  }
  for (const text of ['能不能刷1-7十次', '不要刷1-7十次', '举例：帮我刷1-7十次', '如果可以就刷1-7十次',
    '刷1-7十次，允许吃药', '刷1-7十次再刷2-1一次', '刷1-7', '刷2-1十次', '刷1-7 0次', '刷1-7 2147483648次', '刷1-7十次，五分钟内完成']) {
    assert.equal(authorize(text).action, 'none', text);
  }
});


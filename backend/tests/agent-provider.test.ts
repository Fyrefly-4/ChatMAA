import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateText, tool, jsonSchema, stepCountIs } from 'ai';
import { deepseekModel, providerOptions } from '../src/agent/provider.ts';

test('DeepSeek Responses wire contract uses system, stateless complete tool roundtrip and fixed model', async () => {
  const requests: Record<string, any>[] = [];
  const model = deepseekModel('offline-test-key', async (url, init) => {
    assert.equal(String(url), 'https://api.deepseek.com/responses');
    const body = JSON.parse(String(init?.body)); requests.push(body);
    const output = requests.length === 1
      ? [{ type: 'function_call', id: 'fc-one', call_id: 'call-one', name: 'probe', arguments: '{}' }]
      : [{ type: 'message', id: 'msg-one', role: 'assistant', content: [{ type: 'output_text', text: '已收到工具事实。', annotations: [] }] }];
    return Response.json({ id: `response-${requests.length}`, model: 'deepseek-flash', output,
      usage: { input_tokens: 1, output_tokens: 1 } });
  });
  const value = await generateText({ model, providerOptions, system: '固定规则', prompt: '测试原文', maxRetries: 0,
    stopWhen: stepCountIs(2), prepareStep: ({ stepNumber }) => stepNumber ? { activeTools: [], toolChoice: 'none' } : {},
    tools: { probe: tool({ inputSchema: jsonSchema({ type: 'object', properties: {}, additionalProperties: false }), execute: async () => ({ evidence_source: 'offline_callback_replay' }) }) } });
  assert.equal(value.text, '已收到工具事实。');
  assert.equal(requests.length, 2);
  for (const body of requests) {
    assert.equal(body.model, 'deepseek-flash'); assert.equal(body.store, false);
    assert.equal(body.previous_response_id, undefined);
    assert.equal(body.input[0].role, 'system');
    assert(body.input.some((x: any) => x.role === 'user'));
    assert(!body.input.some((x: any) => x.type === 'item_reference'));
  }
  assert(requests[1].input.some((x: any) => x.type === 'function_call' && x.call_id === 'call-one'));
  assert(requests[1].input.some((x: any) => x.type === 'function_call_output' && x.output.includes('offline_callback_replay')));
  assert.equal(requests[1].tools?.length ?? 0, 0);
});

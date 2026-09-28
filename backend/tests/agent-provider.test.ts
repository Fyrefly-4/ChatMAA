import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateText, tool, jsonSchema, stepCountIs } from 'ai';
import { configuredModel, modelIdentity, providerOptions } from '../src/agent/provider.ts';

test('configured Responses endpoint preserves stateless tool roundtrip and reports selected model', async () => {
  const requests: Record<string, any>[] = [];
  const model = configuredModel({ baseURL: 'https://models.example/v1/', apiKey: 'offline-test-key', model: 'chosen-model' },
    async (url, init) => {
      assert.equal(String(url), 'https://models.example/v1/responses');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer offline-test-key');
      const body = JSON.parse(String(init?.body)); requests.push(body);
      const output = requests.length === 1
        ? [{ type: 'function_call', id: 'fc-one', call_id: 'call-one', name: 'probe', arguments: '{}' }]
        : [{ type: 'message', id: 'msg-one', role: 'assistant', content: [{ type: 'output_text', text: '已收到工具事实。', annotations: [] }] }];
      return Response.json({ id: `response-${requests.length}`, model: 'chosen-model', output,
        usage: { input_tokens: 1, output_tokens: 1 } });
    });
  assert.deepEqual(modelIdentity(model), { provider: 'chatmaa-responses.responses', model: 'chosen-model' });
  const value = await generateText({ model, providerOptions, system: '固定规则', prompt: '测试原文', maxRetries: 0,
    stopWhen: stepCountIs(2), prepareStep: ({ stepNumber }) => stepNumber ? { activeTools: [], toolChoice: 'none' } : {},
    tools: { probe: tool({ inputSchema: jsonSchema({ type: 'object', properties: {}, additionalProperties: false }), execute: async () => ({ evidence_source: 'offline_callback_replay' }) }) } });
  assert.equal(value.text, '已收到工具事实。');
  assert.equal(requests.length, 2);
  for (const body of requests) {
    assert.equal(body.model, 'chosen-model'); assert.equal(body.store, false);
    assert.equal(body.previous_response_id, undefined);
    assert.equal(body.input[0].role, 'system');
    assert(body.input.some((x: any) => x.role === 'user'));
    assert(!body.input.some((x: any) => x.type === 'item_reference'));
  }
  assert(requests[1].input.some((x: any) => x.type === 'function_call' && x.call_id === 'call-one'));
  assert(requests[1].input.some((x: any) => x.type === 'function_call_output' && x.output.includes('offline_callback_replay')));
  assert.equal(requests[1].tools?.length ?? 0, 0);
});

test('model configuration requires all three values and an API prefix', () => {
  const valid = { baseURL: 'http://127.0.0.1:1234/v1', apiKey: 'local-key', model: 'local-model' };
  for (const key of ['baseURL', 'apiKey', 'model'] as const) {
    assert.throws(() => configuredModel({ ...valid, [key]: '' }), /CHATMAA_MODEL_BASE_URL.*CHATMAA_MODEL_API_KEY.*CHATMAA_MODEL_ID/);
  }
  for (const baseURL of ['not-a-url', 'file:///tmp/model', 'https://key@example.com/v1',
    'https://example.com/v1/responses', 'https://example.com/v1?key=secret']) {
    assert.throws(() => configuredModel({ ...valid, baseURL }), /CHATMAA_MODEL_BASE_URL/);
  }
  assert.equal(configuredModel(valid).modelId, 'local-model');
});

test('model factory reads the three project-scoped environment values', () => {
  const names = ['CHATMAA_MODEL_BASE_URL', 'CHATMAA_MODEL_API_KEY', 'CHATMAA_MODEL_ID'] as const;
  const previous = names.map(name => process.env[name]);
  try {
    process.env.CHATMAA_MODEL_BASE_URL = 'https://configured.example/v1';
    process.env.CHATMAA_MODEL_API_KEY = 'test-only';
    process.env.CHATMAA_MODEL_ID = 'selected-by-env';
    assert.equal(configuredModel().modelId, 'selected-by-env');
    delete process.env.CHATMAA_MODEL_ID;
    assert.throws(() => configuredModel(), /CHATMAA_MODEL_ID/);
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
  }
});

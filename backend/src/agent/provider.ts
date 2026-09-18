import { createOpenAI } from '@ai-sdk/openai';

export const MODEL_IDENTITY = { provider: 'deepseek', model: 'deepseek-flash' } as const;
export const providerOptions = { openai: { store: false, systemMessageMode: 'system' } } as const;

export function deepseekModel(apiKey = process.env.DEEPSEEK_API_KEY, fetchImplementation?: typeof fetch) {
  if (!apiKey?.trim()) throw new Error('请通过本地 DEEPSEEK_API_KEY 配置模型凭据');
  return createOpenAI({ apiKey, baseURL: 'https://api.deepseek.com', fetch: fetchImplementation })
    .responses(MODEL_IDENTITY.model);
}

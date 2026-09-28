import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';

export const providerOptions = { openai: { store: false, systemMessageMode: 'system' } } as const;

type ModelSettings = { baseURL?: string; apiKey?: string; model?: string };

export function configuredModel(settings: ModelSettings = {
  baseURL: process.env.CHATMAA_MODEL_BASE_URL,
  apiKey: process.env.CHATMAA_MODEL_API_KEY,
  model: process.env.CHATMAA_MODEL_ID,
}, fetchImplementation?: typeof fetch) {
  const baseURL = settings.baseURL?.trim();
  const apiKey = settings.apiKey?.trim();
  const model = settings.model?.trim();
  if (!baseURL || !apiKey || !model) {
    throw new Error('请配置 CHATMAA_MODEL_BASE_URL、CHATMAA_MODEL_API_KEY 和 CHATMAA_MODEL_ID');
  }
  let url: URL;
  try { url = new URL(baseURL); }
  catch { throw new Error('CHATMAA_MODEL_BASE_URL 必须是有效的 HTTP(S) 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      /\/responses\/?$/.test(url.pathname)) {
    throw new Error('CHATMAA_MODEL_BASE_URL 必须是 API 前缀，不能包含凭据、查询参数或 /responses');
  }
  return createOpenAI({ apiKey, baseURL, name: 'chatmaa-responses', fetch: fetchImplementation }).responses(model);
}

export function modelIdentity(model: LanguageModel) {
  return typeof model === 'string'
    ? { provider: 'registry', model }
    : { provider: model.provider, model: model.modelId };
}

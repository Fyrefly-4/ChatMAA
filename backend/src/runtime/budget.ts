// Kept separate from provider-specific options; limits apply to every Responses endpoint.
export function outputBudget(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.CHATMAA_MODEL_MAX_OUTPUT_TOKENS ?? '12000';
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1000 || value > 16000)
    throw new Error('CHATMAA_MODEL_MAX_OUTPUT_TOKENS must be an integer from 1000 to 16000');
  return value;
}

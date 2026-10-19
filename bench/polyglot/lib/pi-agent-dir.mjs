import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const GATEWAY_BASE_URL = 'https://ai-gateway.cloud.toby.nu/v1';
export const GATEWAY_KEY_ENV = 'HOMELAB_AI_GATEWAY_API_KEY';

// The key is written as an environment reference, never as a literal, so the generated
// models.json is safe to keep in the run directory.
export function piModelsConfig(model, { baseUrl = GATEWAY_BASE_URL } = {}) {
  if (typeof model?.route !== 'string' || model.route.length === 0) throw new Error('model.route is required');
  if (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0) throw new Error(`model ${model.key ?? model.route}: contextWindow must be a positive integer`);
  if (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0) throw new Error(`model ${model.key ?? model.route}: maxTokens must be a positive integer`);
  const provider = model.provider ?? 'litellm';
  return {
    providers: {
      [provider]: {
        api: 'openai-completions',
        baseUrl,
        apiKey: `$${GATEWAY_KEY_ENV}`,
        models: [{ id: model.route, contextWindow: model.contextWindow, maxTokens: model.maxTokens, input: ['text'], reasoning: true }],
      },
    },
  };
}

// Writes <dir>/models.json for one model and returns the absolute directory.
// Pass it as PI_CODING_AGENT_DIR; the worker never reads the user's Pi config.
export async function createPiAgentDir({ model, dir, baseUrl }) {
  const config = piModelsConfig(model, { baseUrl });
  const absolute = resolve(dir);
  await mkdir(absolute, { recursive: true });
  await writeFile(join(absolute, 'models.json'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return absolute;
}

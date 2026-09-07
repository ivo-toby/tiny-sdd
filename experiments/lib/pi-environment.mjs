import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfigValueOrThrow } from '/home/ivo/.local/share/mise/installs/node/24.15.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/resolve-config-value.js';

const participantIds = {
  qwen: ['randal-mi50', 'randal-mi50/llamacpp/Qwen3.6-35B-A3B-UD-Q5_K_XL.gguf'],
  gemma: ['titan', 'titan/llamacpp/gemma4-26b-a4b-256k'],
  nemotron: ['ollama-cloud', 'ollama-cloud/nemotron-3-nano:30b'],
};

export async function preparePiEnvironment(participant) {
  const identity = participantIds[participant];
  if (!identity) throw new Error('Unknown experiment participant');
  const [provider, modelId] = identity;
  const sourcePath = join(
    process.env.PI_CODING_AGENT_DIR ?? '/home/ivo/.config/pi/agent',
    'models.json',
  );
  const source = JSON.parse(await readFile(sourcePath, 'utf8'));
  const piPackage = JSON.parse(await readFile(
    '/home/ivo/.local/share/mise/installs/node/24.15.0/lib/node_modules/@earendil-works/pi-coding-agent/package.json',
    'utf8',
  ));
  const configured = source.providers?.[provider];
  const model = configured?.models?.find((entry) => entry.id === modelId);
  if (!model) throw new Error('Exact configured participant model is missing');
  if (configured.api !== 'openai-completions') {
    throw new Error('Unqualified provider API; do not substitute a transport');
  }
  const url = new URL(configured.baseUrl);
  if (url.username || url.password) throw new Error('Credential-bearing endpoint is unsupported');

  const env = { ...process.env };
  const secretReferences = {};
  let referenceIndex = 0;
  function reference(value) {
    if (typeof value !== 'string' || value.startsWith('!')) {
      throw new Error('Command-backed configuration is not supported by this preparer');
    }
    const resolved = resolveConfigValueOrThrow(value, 'experiment provider value', process.env);
    const name = `TINYSDD_PI_CONFIG_${referenceIndex++}`;
    env[name] = resolved;
    secretReferences[name] = '<process environment; value not retained>';
    return '${' + name + '}';
  }

  const profile = {
    providers: {
      [provider]: {
        api: configured.api,
        baseUrl: configured.baseUrl,
        apiKey: reference(configured.apiKey),
        headers: Object.fromEntries(
          Object.entries(configured.headers ?? {}).map(([name, value]) => [name, reference(value)]),
        ),
        compat: configured.compat,
        models: [model],
      },
    },
  };
  const settings = {
    quietStartup: true,
    defaultThinkingLevel: 'off',
    compaction: { enabled: false },
    retry: { enabled: false, provider: { maxRetries: 0, timeoutMs: 120000 } },
  };
  const stateDir = await mkdtemp(join(tmpdir(), 'tinysdd-pi-state-'));
  await writeFile(join(stateDir, 'models.json'), JSON.stringify(profile, null, 2) + '\n', { mode: 0o600 });
  await writeFile(join(stateDir, 'settings.json'), JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  env.PI_CODING_AGENT_DIR = stateDir;
  env.PI_OFFLINE = '1';
  env.PI_SKIP_VERSION_CHECK = '1';

  return {
    env,
    stateDir,
    provider,
    modelId,
    metadata: {
      participant,
      piVersion: piPackage.version,
      provider,
      modelId,
      advertisedModel: model,
      compatibility: configured.compat,
      settings,
      stateIsolation: 'temporary Pi directory; credentials only referenced from process environment',
      profileSha256: createHash('sha256').update(JSON.stringify(profile)).digest('hex'),
      credentialReferences: Object.keys(secretReferences),
      proxyVersion: 'UNKNOWN',
      proxyRetries: 'UNKNOWN',
      responseCacheFreshness: 'UNKNOWN',
      fallbacks: 'none, user-confirmed',
    },
  };
}

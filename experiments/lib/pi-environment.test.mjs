import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { preparePiEnvironment } from './pi-environment.mjs';

const participants = {
  qwen: {
    provider: 'randal-mi50',
    modelId: 'randal-mi50/llamacpp/Qwen3.6-35B-A3B-UD-Q5_K_XL.gguf',
    contextWindow: 262144,
    maxTokens: 16384,
    compatibility: {
      supportsReasoningEffort: false,
      maxTokensField: 'max_tokens',
      requiresToolResultName: true,
    },
  },
  gemma: {
    provider: 'titan',
    modelId: 'titan/llamacpp/gemma4-26b-a4b-256k',
    contextWindow: 262144,
    maxTokens: 16384,
    compatibility: {
      supportsReasoningEffort: true,
      maxTokensField: 'max_completion_tokens',
      requiresAssistantAfterToolResult: true,
    },
  },
  nemotron: {
    provider: 'ollama-cloud',
    modelId: 'ollama-cloud/nemotron-3-nano:30b',
    contextWindow: 131072,
    maxTokens: 16384,
    compatibility: {
      supportsReasoningEffort: true,
      maxTokensField: 'max_tokens',
      supportsUsageInStreaming: true,
    },
  },
};

function environmentReference(name) {
  return `\${${name}}`;
}

function syntheticNames(participant) {
  const suffix = participant.toUpperCase();
  return {
    apiKey: `TINYSDD_SYNTHETIC_${suffix}_API_KEY`,
    authorization: `TINYSDD_SYNTHETIC_${suffix}_AUTHORIZATION`,
    deployment: `TINYSDD_SYNTHETIC_${suffix}_DEPLOYMENT`,
  };
}

function syntheticValues(participant) {
  const suffix = participant.toUpperCase();
  return {
    apiKey: `SYNTHETIC_API_KEY_${suffix}_MUST_NOT_BE_STORED`,
    authorization: `SYNTHETIC_HEADER_SECRET_${suffix}_MUST_NOT_BE_STORED`,
    deployment: `SYNTHETIC_DEPLOYMENT_${suffix}`,
  };
}

function makeSourceConfig(participant, overrides = {}) {
  const target = participants[participant];
  const names = syntheticNames(participant);
  const model = {
    id: target.modelId,
    name: `Synthetic ${participant}`,
    reasoning: participant !== 'gemma',
    contextWindow: target.contextWindow,
    maxTokens: target.maxTokens,
    input: ['text'],
  };
  const provider = {
    api: 'openai-completions',
    baseUrl: 'https://proxy.synthetic.invalid/v1',
    apiKey: environmentReference(names.apiKey),
    headers: {
      Authorization: `Bearer ${environmentReference(names.authorization)}`,
      'X-LiteLLM-Source': `tinysdd/${environmentReference(names.deployment)}`,
    },
    compat: target.compatibility,
    models: [model],
  };

  return {
    providers: {
      [target.provider]: {
        ...provider,
        ...overrides,
      },
    },
  };
}

async function writeSyntheticInputs(participant, overrides = {}) {
  const sourceDir = await mkdtemp(join(tmpdir(), 'tinysdd-pi-input-'));
  const sourceConfig = makeSourceConfig(participant, overrides);
  const modelsPath = join(sourceDir, 'models.json');
  const modelsText = `${JSON.stringify(sourceConfig, null, 2)}\n`;
  await writeFile(modelsPath, modelsText, { mode: 0o600 });

  const authPath = join(sourceDir, 'auth.json');
  const authText = `${JSON.stringify({
    [participants[participant].provider]: {
      type: 'api_key',
      key: `SYNTHETIC_AUTH_JSON_${participant}_MUST_NOT_BE_COPIED`,
    },
  }, null, 2)}\n`;
  await writeFile(authPath, authText, { mode: 0o600 });

  return { authPath, authText, modelsPath, modelsText, sourceConfig, sourceDir };
}

async function withEnvironment(values, callback) {
  const previous = new Map();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, Object.hasOwn(process.env, name) ? process.env[name] : undefined);
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  try {
    return await callback();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

test('prepares each exact participant with isolated, placeholder-backed state', async () => {
  for (const participant of Object.keys(participants)) {
    const target = participants[participant];
    const names = syntheticNames(participant);
    const values = syntheticValues(participant);
    const inputs = await writeSyntheticInputs(participant);

    const prepared = await withEnvironment({
      PI_CODING_AGENT_DIR: inputs.sourceDir,
      [names.apiKey]: values.apiKey,
      [names.authorization]: values.authorization,
      [names.deployment]: values.deployment,
    }, () => preparePiEnvironment(participant));

    assert.equal(prepared.provider, target.provider);
    assert.equal(prepared.modelId, target.modelId);
    assert.equal(prepared.stateDir === inputs.sourceDir, false);
    assert.deepEqual(prepared.metadata.compatibility, target.compatibility);
    assert.deepEqual(prepared.metadata.advertisedModel, inputs.sourceConfig.providers[target.provider].models[0]);
    assert.equal(prepared.metadata.advertisedModel.contextWindow, target.contextWindow);
    assert.equal(prepared.metadata.advertisedModel.maxTokens, target.maxTokens);

    const stateModelsPath = join(prepared.stateDir, 'models.json');
    const stateSettingsPath = join(prepared.stateDir, 'settings.json');
    const stateModels = JSON.parse(await readFile(stateModelsPath, 'utf8'));
    const stateSettings = JSON.parse(await readFile(stateSettingsPath, 'utf8'));
    const stateProvider = stateModels.providers[target.provider];
    const references = prepared.metadata.credentialReferences;

    assert.equal(references.length, 3);
    assert.ok(references.every((name) => /^TINYSDD_PI_CONFIG_\d+$/.test(name)));
    assert.deepEqual(
      references.map((name) => prepared.env[name]),
      [
        values.apiKey,
        `Bearer ${values.authorization}`,
        `tinysdd/${values.deployment}`,
      ],
    );
    assert.equal(prepared.env.PI_CODING_AGENT_DIR, prepared.stateDir);
    assert.equal(prepared.env.PI_OFFLINE, '1');
    assert.equal(prepared.env.PI_SKIP_VERSION_CHECK, '1');

    assert.equal(stateProvider.apiKey, environmentReference(references[0]));
    assert.deepEqual(stateProvider.headers, {
      Authorization: environmentReference(references[1]),
      'X-LiteLLM-Source': environmentReference(references[2]),
    });
    assert.deepEqual(stateProvider.compat, target.compatibility);
    assert.deepEqual(stateProvider.models, [prepared.metadata.advertisedModel]);
    assert.deepEqual(stateSettings, prepared.metadata.settings);

    const stateEntries = await readdir(prepared.stateDir);
    assert.deepEqual(stateEntries.sort(), ['models.json', 'settings.json']);
    const stateAndMetadata = JSON.stringify({ metadata: prepared.metadata, stateModels, stateSettings });
    for (const secret of [
      values.apiKey,
      values.authorization,
      `SYNTHETIC_AUTH_JSON_${participant}_MUST_NOT_BE_COPIED`,
    ]) {
      assert.equal(stateAndMetadata.includes(secret), false);
    }
    assert.match(stateAndMetadata, /\$\{TINYSDD_PI_CONFIG_\d+\}/);

    assert.equal(await readFile(inputs.modelsPath, 'utf8'), inputs.modelsText);
    assert.equal(await readFile(inputs.authPath, 'utf8'), inputs.authText);
  }
});

test('rejects an unsupported participant before reading configuration', async () => {
  await assert.rejects(
    () => preparePiEnvironment('synthetic-unsupported-participant'),
    /Unknown experiment participant/,
  );
});

test('rejects a source config without the exact participant model', async () => {
  const participant = 'qwen';
  const inputs = await writeSyntheticInputs(participant, {
    models: [{ id: 'synthetic-wrong-model-id', contextWindow: 1, maxTokens: 1 }],
  });

  await withEnvironment({ PI_CODING_AGENT_DIR: inputs.sourceDir }, async () => {
    await assert.rejects(
      () => preparePiEnvironment(participant),
      /Exact configured participant model is missing/,
    );
  });
  assert.equal(await readFile(inputs.modelsPath, 'utf8'), inputs.modelsText);
});

test('rejects command-backed API-key configuration without executing it', async () => {
  const participant = 'gemma';
  const inputs = await writeSyntheticInputs(participant, {
    apiKey: '!printf SYNTHETIC_COMMAND_OUTPUT',
  });

  await withEnvironment({ PI_CODING_AGENT_DIR: inputs.sourceDir }, async () => {
    await assert.rejects(
      () => preparePiEnvironment(participant),
      /Command-backed configuration is not supported by this preparer/,
    );
  });
  assert.equal(await readFile(inputs.modelsPath, 'utf8'), inputs.modelsText);
});

test('rejects a credential-bearing endpoint', async () => {
  const participant = 'nemotron';
  const names = syntheticNames(participant);
  const values = syntheticValues(participant);
  const inputs = await writeSyntheticInputs(participant, {
    baseUrl: 'https://synthetic-user:SYNTHETIC_URL_PASSWORD@proxy.synthetic.invalid/v1',
  });

  await withEnvironment({
    PI_CODING_AGENT_DIR: inputs.sourceDir,
    [names.apiKey]: values.apiKey,
    [names.authorization]: values.authorization,
    [names.deployment]: values.deployment,
  }, async () => {
    await assert.rejects(
      () => preparePiEnvironment(participant),
      /Credential-bearing endpoint is unsupported/,
    );
  });
  assert.equal(await readFile(inputs.modelsPath, 'utf8'), inputs.modelsText);
});

test('rejects an unset referenced environment variable', async () => {
  const participant = 'qwen';
  const names = syntheticNames(participant);
  const inputs = await writeSyntheticInputs(participant, {
    apiKey: environmentReference('TINYSDD_SYNTHETIC_UNSET_API_KEY'),
  });

  await withEnvironment({
    PI_CODING_AGENT_DIR: inputs.sourceDir,
    TINYSDD_SYNTHETIC_UNSET_API_KEY: undefined,
  }, async () => {
    await assert.rejects(
      () => preparePiEnvironment(participant),
      /environment variable: TINYSDD_SYNTHETIC_UNSET_API_KEY/,
    );
  });
  assert.equal(await readFile(inputs.modelsPath, 'utf8'), inputs.modelsText);
  assert.equal(Object.hasOwn(process.env, names.apiKey), false);
});

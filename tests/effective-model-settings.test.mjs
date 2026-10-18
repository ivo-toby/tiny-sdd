import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectEffectiveModelSettings, assertEffectiveModelSettingsConfirmed } from '../src/effective-model-settings.mjs';

const worker = { type: 'pi', provider: 'fixture', model: 'model' };

async function fixture(t, model) {
  const sourceAgentDir = await mkdtemp(join(tmpdir(), 'tinysdd-settings-'));
  t.after(() => rm(sourceAgentDir, { recursive: true, force: true }));
  const models = { providers: { fixture: { api: 'openai-completions', baseUrl: 'https://example.invalid/v1?key=synthetic-query-secret', apiKey: 'synthetic-api-secret', headers: { Authorization: 'synthetic-header-secret' }, models: [{ id: 'model', ...model }] } } };
  await writeFile(join(sourceAgentDir, 'models.json'), JSON.stringify(models));
  return { worker, sourceAgentDir, sourceEnv: {}, entryKind: 'real' };
}

test('settings inspection reports effective overrides and sources without credential fields', async (t) => {
  const input = await fixture(t, { reasoning: false, maxTokens: 32768, contextWindow: 256000, thinkingLevelMap: { off: 'none', high: 'high' } });
  const report = await inspectEffectiveModelSettings({ ...input, profile: { runtime: { reasoning: true, thinking: 'high', compat: { thinkingFormat: 'openai' } } } });
  assert.equal(report.settings.reasoning, true);
  assert.equal(report.settings.reasoningSource, 'profile');
  assert.equal(report.settings.thinkingSource, 'profile');
  assert.equal(report.settings.thinkingDefault, 'off');
  assert.equal(report.settings.effectiveThinkingControl, 'sent');
  assert.equal(report.settings.maxTokensSource, 'model');
  assert.equal(report.settings.contextWindow, 256000);
  assert.deepEqual(report.settings.thinkingLevelMap, { off: 'none', high: 'high' });
  assert.doesNotMatch(JSON.stringify(report), /synthetic-(?:api|header|query)-secret|apiKey|Authorization/);
  assertEffectiveModelSettingsConfirmed(report, { settingsDigest: report.settingsDigest });
});

test('synthetic defaults require named thinking mismatch acknowledgement and current confirmation', async (t) => {
  const input = await fixture(t, { reasoning: false, maxTokens: 1024 });
  const report = await inspectEffectiveModelSettings({ ...input, entryKind: 'synthetic', observedReasoningTokens: 1024 });
  assert.equal(report.settings.requestedThinking, 'off');
  assert.equal(report.settings.thinkingSource, 'tinysdd-default');
  assert.equal(report.settings.effectiveThinkingControl, 'not-sent');
  assert.equal(report.settings.contextWindow, 'UNKNOWN');
  assert.deepEqual(report.findings.map(({ code }) => code), ['THINKING_CONTROL_MISMATCH', 'SYNTHETIC_MODEL_ENTRY', 'REASONING_EXHAUSTS_RESPONSE_BUDGET']);
  assert.throws(() => assertEffectiveModelSettingsConfirmed(report), { code: 'MODEL_SETTINGS_CONFIRMATION_REQUIRED' });
  assert.throws(() => assertEffectiveModelSettingsConfirmed(report, { settingsDigest: report.settingsDigest }), { code: 'MODEL_SETTINGS_FINDING_ACKNOWLEDGEMENT_REQUIRED' });
  const confirmation = { settingsDigest: report.settingsDigest, acknowledgedFindings: ['THINKING_CONTROL_MISMATCH'] };
  assertEffectiveModelSettingsConfirmed(report, confirmation);
  const changed = await inspectEffectiveModelSettings({ ...input, entryKind: 'real' });
  assert.throws(() => assertEffectiveModelSettingsConfirmed(changed, confirmation), { code: 'MODEL_SETTINGS_CONFIRMATION_REQUIRED' });
});

test('unconfigured limits remain explicit defaults and low caps alone never create a refusal threshold', async (t) => {
  const input = await fixture(t, { reasoning: true, compat: { thinkingFormat: 'openai' }, thinkingLevelMap: { off: 'none' } });
  const report = await inspectEffectiveModelSettings(input);
  assert.equal(report.settings.maxTokens, 16384);
  assert.equal(report.settings.maxTokensSource, 'pi-default');
  assert.equal(report.observedReasoningTokens, 'UNKNOWN');
  assert.equal(report.findings.length, 0);
  await assert.rejects(inspectEffectiveModelSettings({ ...input, entryKind: undefined }), { code: 'MODEL_SETTINGS_INVALID' });
  await assert.rejects(inspectEffectiveModelSettings({ ...input, observedReasoningTokens: -1 }), { code: 'MODEL_SETTINGS_INVALID' });
});

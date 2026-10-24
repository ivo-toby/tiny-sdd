import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const DIR = join(REPO, 'skills', 'tinysdd', 'assets', 'harness', 'opencode');

// Copies of OpenCode's Wildcard.match, Permission.evaluate and tool.ts whollyDisabled at
// sst/opencode 20a6cc7 (non-Windows). This checks the template's rules, not live OpenCode.
function match(input, pattern) {
  const normalized = input.replaceAll('\\', '/');
  let escaped = pattern.replaceAll('\\', '/').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  if (escaped.endsWith(' .*')) escaped = `${escaped.slice(0, -3)}( .*)?`;
  return new RegExp(`^${escaped}$`, 's').test(normalized);
}
const evaluate = (action, resource, rules) =>
  rules.findLast((rule) => match(action, rule.action) && match(resource, rule.resource))?.effect ?? 'ask';
const hidden = (permission, rules) => {
  const rule = rules.findLast((item) => match(permission, item.action));
  return rule?.resource === '*' && rule.effect === 'deny';
};

// Agent.Info.default in packages/schema/src/agent.ts.
const DEFAULT_AGENT = [
  { action: '*', resource: '*', effect: 'allow' },
  { action: 'read', resource: '*.env', effect: 'ask' },
  { action: 'read', resource: '*.env.*', effect: 'ask' },
  { action: 'read', resource: '*.env.example', effect: 'allow' },
];

async function childRules() {
  const text = await readFile(join(DIR, 'tinysdd-slice-worker.md'), 'utf8');
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n/u)[1];
  assert.match(frontmatter, /^mode: subagent$/mu);
  assert.match(frontmatter, /^model: "[^"/#]+\/[^"#]+"$/mu);
  assert.match(frontmatter, /^steps: \d+$/mu);
  return [...frontmatter.matchAll(/^ {2}- \{ action: "([^"]+)", resource: "([^"]+)", effect: "(allow|deny|ask)" \}$/gmu)]
    .map(([, action, resource, effect]) => ({ action, resource, effect }));
}

async function parentGlobalRules() {
  return JSON.parse(await readFile(join(DIR, 'parent-opencode.json'), 'utf8')).permissions;
}

function caseVariants(word) {
  return [...word].reduce((acc, ch) => acc.flatMap((prefix) => [...new Set([prefix + ch, prefix + ch.toUpperCase()])]), ['']);
}

// OpenCode loads opencode.json(c) and .opencode/.claude/.agents from the candidate. On a
// case-insensitive filesystem any letter case reaches the same file, so every variant must be denied.
const CONFIG_PATHS = [
  ...['opencode', 'OpenCode', 'OPENCODE'].flatMap((stem) =>
    [...caseVariants('json'), ...caseVariants('jsonc')].map((extension) => `${stem}.${extension}`)),
  ...['.opencode', '.OpenCode', '.OPENCODE'].flatMap((root) => [`${root}/agents/tinysdd-slice-worker.md`, `${root}/opencode.json`]),
  '.claude/skills/x/SKILL.md',
  '.Claude/settings.json',
  '.agents/skills/x/SKILL.md',
  '.AGENTS/skills/x/SKILL.md',
];

test('opencode slice worker exposes only file tools and denies paths outside the candidate', async () => {
  // Global config rules come before the agent's own rules in OpenCode's agent loader.
  const rules = [...await parentGlobalRules(), ...await childRules()];
  for (const tool of ['read', 'edit']) assert.equal(hidden(tool, rules), false, tool);
  for (const tool of ['shell', 'glob', 'grep', 'webfetch', 'websearch', 'subagent', 'skill', 'question', 'todowrite', 'execute', 'some_mcp_tool']) {
    assert.equal(hidden(tool, rules), true, tool);
  }
  assert.equal(evaluate('read', 'src/a.mjs', rules), 'allow');
  assert.equal(evaluate('edit', 'src/a.mjs', rules), 'allow');
  assert.equal(evaluate('edit', 'src/new-file.test.mjs', rules), 'allow');
  assert.equal(evaluate('read', 'config/.env', rules), 'deny');
  assert.equal(evaluate('external_directory', '/abs/project/.tinysdd/runs/worker-x/*', rules), 'deny');
});

test('opencode slice worker cannot write candidate-local config that would redefine it', async () => {
  const rules = [...await parentGlobalRules(), ...await childRules()];
  for (const path of CONFIG_PATHS) assert.equal(evaluate('edit', path, rules), 'deny', path);
});

test('opencode templates deny the same configuration paths', async () => {
  const configRules = (rules) => rules.filter((rule) => rule.action === 'edit' && rule.effect === 'deny' && !rule.resource.includes('env'));
  assert.deepEqual(configRules(await childRules()), configRules(await parentGlobalRules()));
  assert.equal(CONFIG_PATHS.filter((path) => !path.startsWith('.')).length, 144);
});

test('opencode parent config asks before shell and external reads and only delegates to the slice worker', async () => {
  const rules = [...DEFAULT_AGENT, ...await parentGlobalRules()];
  assert.equal(evaluate('external_directory', '/abs/project/.tinysdd/runs/worker-x/*', rules), 'ask');
  assert.equal(evaluate('shell', 'npm test', rules), 'ask');
  assert.equal(evaluate('subagent', 'tinysdd-slice-worker', rules), 'allow');
  assert.equal(evaluate('subagent', 'explore', rules), 'deny');
  assert.equal(evaluate('subagent', 'general', rules), 'deny');
  for (const path of CONFIG_PATHS) assert.equal(evaluate('edit', path, rules), 'deny', path);
});

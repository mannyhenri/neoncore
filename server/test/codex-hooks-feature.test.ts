import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { enableCodexHooksFeature, isCodexHooksFeatureEnabled } from '../src/routes/tools.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CODEX_HOOK_INTEGRATION_FILES = [
  'server/src/routes/tools.ts',
  'agent/hooks/codex-permission-proxy.sh',
  'agent/hooks/codex-reporter.sh',
] as const;

const cases = [
  {
    name: 'creates a features table for an empty config',
    input: '',
    expected: '[features]\nhooks = true\n',
  },
  {
    name: 'adds hooks to an existing features table',
    input: '[features]\njs_repl = false\n\n[projects.test]\ntrust_level = "trusted"\n',
    expected: '[features]\njs_repl = false\nhooks = true\n\n[projects.test]\ntrust_level = "trusted"\n',
  },
  {
    name: 'migrates the deprecated feature key',
    input: '[features]\ncodex_hooks = true\njs_repl = false\n',
    expected: '[features]\nhooks = true\njs_repl = false\n',
  },
  {
    name: 'enables an explicitly disabled current key',
    input: '[features]\nhooks = false\n',
    expected: '[features]\nhooks = true\n',
  },
  {
    name: 'is idempotent when hooks are already enabled',
    input: '[features]\nhooks = true\n',
    expected: '[features]\nhooks = true\n',
  },
  {
    name: 'appends a features table after a config with a trailing newline',
    input: 'model = "gpt-5"\n',
    expected: 'model = "gpt-5"\n\n[features]\nhooks = true\n',
  },
  {
    name: 'appends a features table after a config without a trailing newline',
    input: 'model = "gpt-5"',
    expected: 'model = "gpt-5"\n\n[features]\nhooks = true\n',
  },
  {
    name: 'preserves the absence of a trailing newline in an existing table',
    input: '[features]\njs_repl = false',
    expected: '[features]\njs_repl = false\nhooks = true',
  },
  {
    name: 'removes a deprecated key after the current key',
    input: '[features]\nhooks = false\ncodex_hooks = true\n',
    expected: '[features]\nhooks = true\n',
  },
  {
    name: 'removes a current key after migrating the deprecated key',
    input: '[features]\ncodex_hooks = false\nhooks = false\n',
    expected: '[features]\nhooks = true\n',
  },
  {
    name: 'accepts whitespace and a comment on the features header',
    input: '  [features] # current flags\njs_repl = false\n',
    expected: '  [features] # current flags\njs_repl = false\nhooks = true\n',
  },
  {
    name: 'inserts before an array-of-tables boundary',
    input: '[features]\njs_repl = false\n\n[[profiles]]\nname = "work"\n',
    expected: '[features]\njs_repl = false\nhooks = true\n\n[[profiles]]\nname = "work"\n',
  },
  {
    name: 'enables an existing dotted feature key',
    input: 'features.hooks = false\nmodel = "gpt-5"\n',
    expected: 'features.hooks = true\nmodel = "gpt-5"\n',
  },
  {
    name: 'migrates a deprecated dotted feature key',
    input: 'features.codex_hooks = true\n',
    expected: 'features.hooks = true\n',
  },
  {
    name: 'adds a dotted hook beside another dotted feature key',
    input: 'features.js_repl = false\nmodel = "gpt-5"\n',
    expected: 'features.js_repl = false\nfeatures.hooks = true\nmodel = "gpt-5"\n',
  },
] as const;

test('Codex hook installation enables every supported config state', async (t) => {
  assert.equal(cases.length, 15);

  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const actual = enableCodexHooksFeature(scenario.input);
      assert.equal(actual, scenario.expected);
      assert.doesNotMatch(actual, /^codex_hooks\s*=/m);
      assert.match(actual, /^(?:features\.)?hooks\s*=\s*true\s*$/m);
    });
  }
});

test('Codex install status requires the current hook feature to be enabled', () => {
  const states = [
    { input: '', enabled: false },
    { input: '[features]\ncodex_hooks = true\n', enabled: false },
    { input: '[features]\nhooks = false\n', enabled: false },
    { input: '[features]\nhooks = true\n', enabled: true },
    { input: '[features]\nhooks = true # installed by NeonCore\n', enabled: true },
    { input: '[features]\nhooks = true\n\n[other]\nhooks = false\n', enabled: true },
    { input: '[features]\njs_repl = false\n[[profiles]]\nhooks = true\n', enabled: false },
    { input: 'features.hooks = false\n', enabled: false },
    { input: 'features.hooks = true\n', enabled: true },
    { input: 'features.codex_hooks = true\n', enabled: false },
  ] as const;

  assert.equal(states.length, 10);
  for (const state of states) assert.equal(isCodexHooksFeatureEnabled(state.input), state.enabled);
});

test('every Codex hook integration surface uses the current feature name', () => {
  assert.equal(CODEX_HOOK_INTEGRATION_FILES.length, 3);

  for (const relativePath of CODEX_HOOK_INTEGRATION_FILES) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    assert.doesNotMatch(
      source,
      /\bcodex_hooks\s*=\s*true/,
      `${relativePath} still instructs Codex to enable the retired feature`,
    );
  }
});

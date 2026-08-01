/**
 * Only three engines are supported: claude, codex, gridlight.
 *
 * The user asked for this twice ("we should only have gridlight, codex and claude", then
 * "yes remove the others") and it survived three confers unexecuted — because the DATABASE
 * was already clean (claude/codex/gridlight only), so every check anyone ran came back
 * correct while the CODE still shipped six engines, seven hook files, installer entries and
 * UI badges for three of them.
 *
 * That is the failure this suite prevents: the removal looked done from the data and was not
 * done in the code. So it iterates the REMOVED set against every surface an engine can hide
 * in, rather than asserting the enum and calling it finished. Re-adding an engine means
 * failing here first, deliberately.
 *
 * `cursor` needs care: it is also a CSS property, and a naive grep reports ~25 files that are
 * almost all `cursor-pointer`. Matching QUOTED values only is what makes the set real rather
 * than alarming.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', '..');
/**
 * Removed engines, and how safely each NAME can be matched.
 *
 * `cursor` is a CSS property AND an ordinary English word ("cursor is on the first line"), so
 * bare-identifier matching floods with prose. `gemini` and `amazonq` are distinctive, and
 * matching them bare is what catches an unquoted object key. Encoding the ambiguity per engine
 * beats one matcher that is either too narrow for two of them or too loud for the third.
 */
const REMOVED = [
  { id: 'gemini', bareSafe: true },
  { id: 'amazonq', bareSafe: true },
  { id: 'cursor', bareSafe: false },
] as const;
const SUPPORTED = ['claude', 'codex', 'gridlight'] as const;

/** Source trees that ship. Tests and build output are excluded on purpose: this file names the
 *  removed engines by necessity, and dist/ is regenerated. */
const SURFACES = [
  'server/src',
  'packages/client/src',
  'dashboard/src',
  'agent/hooks',
  'agent/relay',
  'mcp',
  // extension/ and mobile/ ship too, and omitting them is how this guard passed 8/8 while
  // BOTH still declared the full six-engine union — extension.ts:29 and mobile/types.ts:5.
  // A scan that excludes a shipping surface is a green number pointed at the wrong scope.
  'extension/src',
  'mobile/src',
];

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'dist' ? [] : walk(full);
    return /\.(ts|tsx|js|py|sh)$/.test(e.name) ? [full] : [];
  });
}

const FILES = SURFACES.flatMap((s) => walk(path.join(ROOT, s)));

test('the shipped surfaces are non-empty — an empty scan would pass vacuously', () => {
  assert.ok(FILES.length > 50, `expected to scan the real tree, found ${FILES.length} files`);
});

for (const { id: engine, bareSafe } of REMOVED) {
  test(`'${engine}' appears nowhere as an engine value in shipped code`, () => {
    const hits: string[] = [];
    for (const file of FILES) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        // Quoted VALUE or bare IDENTIFIER/KEY. Matching only quoted values passed 9/9 while
        // SettingsModal.tsx still carried `gemini: {...}` and `amazonq: {...}` as unquoted object
        // keys — a dead engine fully wired into the settings UI, invisible to the guard meant to
        // find exactly that. A matcher narrower than the thing it guards is its own dead drop.
        const quoted = new RegExp(`['"\`]${engine}['"\`]`).test(line);
        const bare = bareSafe
          && new RegExp(`(^|[^a-zA-Z0-9'"\`_-])${engine}([^a-zA-Z0-9'"\`_-]|$)`).test(line);
        if (!quoted && !bare) return;
        hits.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim().slice(0, 90)}`);
      });
    }
    assert.deepEqual(hits, [], `'${engine}' is still wired in:\n  ${hits.join('\n  ')}`);
  });

  test(`no '${engine}' hook files ship`, () => {
    const hooks = fs.existsSync(path.join(ROOT, 'agent/hooks'))
      ? fs.readdirSync(path.join(ROOT, 'agent/hooks')).filter((f) => f.startsWith(engine))
      : [];
    assert.deepEqual(hooks, [], `these still ship: ${hooks.join(', ')}`);
  });
}

test('AgentType lists exactly the three supported engines, in BOTH copies', () => {
  // Two copies exist (server and the shared client package) and they have drifted before.
  const COPIES = ['server/src/types.ts', 'packages/client/src/types.ts'];
  const wrong: string[] = [];
  for (const rel of COPIES) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const line = src.split('\n').find((l) => l.includes('export type AgentType')) ?? '';
    const listed = [...line.matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort();
    if (JSON.stringify(listed) !== JSON.stringify([...SUPPORTED].sort())) {
      wrong.push(`${rel}: ${listed.join(', ')}`);
    }
  }
  assert.deepEqual(wrong, [], `AgentType must be exactly ${SUPPORTED.join(', ')}:\n  ${wrong.join('\n  ')}`);
});

test('TranscriptEngine carries no removed engine either', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server/src/types.ts'), 'utf8');
  const line = src.split('\n').find((l) => l.includes('export type TranscriptEngine')) ?? '';
  const listed = [...line.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  const strays = listed.filter((e) => REMOVED.some((r) => r.id === e));
  assert.deepEqual(strays, [], `TranscriptEngine still lists ${strays.join(', ')}`);
});

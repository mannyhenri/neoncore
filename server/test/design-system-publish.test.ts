/**
 * STEP 2 OF THE DESIGN SYSTEM: the direction is finalized into a whole system, and that system is
 * put — written, committed, pushed — into EVERY repo of the project, touching nothing else there.
 * Real git repositories, in a temp folder, with a real remote.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import db from '../src/db.js';
import { saveDesignSystem, getDesignSystem, DesignSystemError } from '../src/lib/design-system.js';
import { finalizeProject, publishProject, projectRepos, publishToRepo } from '../src/lib/design-system-publish.js';
import {
  finalize, filesOf, tokensCss, componentsCss, referenceHtml, guideMd, withAgentBlock, agentBlock, contrast, scale, stackOf,
  BLOCK_START, BLOCK_END, DESIGN_DIR, type DirectionTokens, type DesignSystemSpec,
} from '../src/lib/design-system-build.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-publish-'));
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
let n = 0;

/** A repo with one commit; with `remote`, a bare remote it tracks. */
function repo(name: string, opts: { remote?: boolean } = {}): { dir: string; remote: string } {
  const dir = path.join(ROOT, `${name}-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'test@example.com'); sh(dir, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
  sh(dir, 'add', '.'); sh(dir, 'commit', '-q', '-m', 'first');
  let remote = '';
  if (opts.remote) {
    remote = `${dir}.git`;
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    sh(dir, 'remote', 'add', 'origin', remote); sh(dir, 'push', '-q', '-u', 'origin', 'main');
  }
  return { dir, remote };
}
function project(repos: string[]): string {
  const id = `dsp-${++n}`;
  db.prepare(`INSERT INTO projects (id, name, description, primary_repo, color, created_at, updated_at) VALUES (?,?,'',?,'#fff',?,?)`).run(id, 'Atlas', repos[0] ?? '', '2026-01-01', '2026-01-01');
  for (const r of repos.slice(1)) db.prepare('INSERT INTO project_cartridges (project_id, repo_path) VALUES (?, ?)').run(id, r);
  return id;
}
const tokens = (over: Partial<DirectionTokens> = {}): DirectionTokens => ({
  dark: false, colors: { bg: '#fbfbfd', surface: '#ffffff', text: '#14161c', muted: '#5b6070', primary: '#d6412f', onPrimary: '#ffffff', accent: '#168f84', border: '#dcdfe6' },
  fontHeading: 'Didot', fontBody: 'Avenir Next', radius: 6, density: 'cozy', surface: 'flat', ...over,
});
const DARK: Partial<DirectionTokens> = { dark: true, colors: { bg: '#0b0e16', surface: '#141926', text: '#eef1f8', muted: '#9aa3b8', primary: '#7aa2ff', onPrimary: '#0b0d12', accent: '#ffb86b', border: '#2a3246' }, surface: 'glass', radius: 14 };
const variation = (id: string, over: Partial<DirectionTokens> = {}) => ({ id, name: `Direction ${id}`, rationale: `Why ${id} looks this way.`, comments: [], tokens: tokens(over) });
const exploration = (selected: string | null) => ({
  inspirations: [], rounds: [{ id: 'r1', at: '2026-11-21T10:00:00Z', brief: '', basedOn: null, variations: [variation('a'), variation('b', DARK), variation('c', { surface: 'outline', density: 'roomy', radius: 0 }), variation('d', { surface: 'soft', density: 'compact', radius: 18 })] }],
  selected: selected ? { roundId: 'r1', variationId: selected } : null,
});
const VARIANTS: Partial<DirectionTokens>[] = [{}, DARK, { surface: 'outline', density: 'roomy', radius: 0 }, { surface: 'soft', density: 'compact', radius: 18 }];
const spec = (over: Partial<DirectionTokens> = {}, version = 1): DesignSystemSpec => finalize({ name: 'Quiet Editorial', rationale: 'Serif headlines, generous margins.', tokens: tokens(over), version, project: 'Atlas' });

test('finalizing works the WHOLE system out of a direction — for every surface style, density and mode', () => {
  for (const over of VARIANTS) {
    const s = spec(over);
    const label = `${s.surface}/${s.density}/${s.dark ? 'dark' : 'light'}`;
    for (const group of ['primary', 'accent', 'neutral'] as const) assert.deepEqual(Object.keys(s.colors[group]), ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900'], label);
    assert.deepEqual(Object.keys(s.colors.semantic).sort(), ['danger', 'info', 'success', 'warning']);
    assert.deepEqual(Object.keys(s.type.sizes), ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', 'display']);
    assert.equal(Object.keys(s.space).length, 9); assert.deepEqual(Object.keys(s.radius), ['none', 'sm', 'md', 'lg', 'full']); assert.deepEqual(Object.keys(s.shadow), ['sm', 'md', 'lg']);
    const all = [...Object.values(s.colors.roles), ...Object.values(s.colors.primary), ...Object.values(s.colors.accent), ...Object.values(s.colors.neutral), ...Object.values(s.colors.semantic)];
    for (const c of all) assert.match(c, /^#[0-9a-f]{6}$/, label);
    assert.equal(s.colors.primary['500'], s.colors.roles.primary);
    const lights = Object.values(s.colors.primary).map((c) => contrast(c, '#000000'));
    for (let i = 1; i < lights.length; i++) assert.ok(lights[i] <= lights[i - 1], `${label}: the primary scale is not light → dark`);
    assert.ok(contrast(s.colors.roles.text, s.colors.roles.background) >= 7, `${label}: text`);
    assert.ok(contrast(s.colors.roles['text-muted'], s.colors.roles.background) >= 4.5, `${label}: muted`);
    assert.ok(contrast(s.colors.roles['on-primary'], s.colors.roles.primary) >= 4.5, `${label}: on-primary`);
    for (const [k, c] of Object.entries(s.colors.semantic)) assert.ok(contrast(c, s.colors.roles.background) >= 4.5, `${label}: ${k}`);
  }
  assert.equal(Object.keys(scale('#3366ff')).length, 10);
  assert.match(stackOf('Didot'), /serif$/);
  assert.equal(/[;{}]/.test(stackOf('Evil"; } body { x')), false, 'a font name can break out of the CSS');
});

test('the files: five of them, each complete, each using only the system\'s own tokens — and the same input gives the same bytes', () => {
  for (const over of VARIANTS) {
    const s = spec(over);
    const files = filesOf(s);
    assert.deepEqual(files.map((f) => f.path), ['tokens.json', 'tokens.css', 'components.css', 'index.html', 'DESIGN-SYSTEM.md'].map((f) => `${DESIGN_DIR}/${f}`));
    assert.deepEqual(filesOf(spec(over)), files, 'not deterministic');
    const css = tokensCss(s);
    const declared = new Set([...css.matchAll(/(--ds-[\w-]+):/g)].map((m) => m[1]));
    assert.ok(declared.size >= 70, `only ${declared.size} tokens`);
    for (const [name, text] of [['components.css', componentsCss(s)], ['index.html', referenceHtml(s)], ['DESIGN-SYSTEM.md', guideMd(s)]] as const) {
      const used = [...text.matchAll(/var\((--ds-[\w-]+)\)/g)].map((m) => m[1]);
      assert.ok(used.length > 0 || name === 'DESIGN-SYSTEM.md');
      for (const u of used) assert.ok(declared.has(u), `${name} uses ${u}, which tokens.css does not declare`);
      for (const m of text.matchAll(/`(--ds-[\w-]+)`/g)) if (!m[1].endsWith('-')) assert.ok(declared.has(m[1]), `${name} documents ${m[1]}, which does not exist`);
    }
    assert.equal(componentsCss(s).replace(/\/\*[\s\S]*?\*\//g, '').match(/#[0-9a-fA-F]{3,8}\b/g), null, 'components.css hard-codes a colour');
    const json = JSON.parse(files[0].content);
    assert.equal(json.version, s.version); assert.equal(json.colors.roles.primary, s.colors.roles.primary);
    const html = referenceHtml(s);
    assert.equal(/<link|<script|src=|@import|url\(/.test(html), false, 'the reference page loads something');
    for (const part of ['ds-btn--primary', 'ds-input', 'ds-card', 'ds-badge', 'ds-table', 'ds-nav']) assert.ok(html.includes(part), part);
  }
  const nasty = finalize({ name: '<script>alert(1)</script>', rationale: '"><img onerror=x>', tokens: tokens(), version: 1, project: 'A & <b>' });
  const html = referenceHtml(nasty);
  assert.equal(html.includes('<script>alert'), false); assert.equal(html.includes('<img onerror'), false); assert.equal(html.includes('A & <b>'), false);
  for (const f of filesOf(nasty).filter((x) => !x.path.endsWith(".json"))) assert.equal(/<script>|<img /.test(f.content), false, f.path);
});

test('the pointer for agents is added once, replaced in place, and never disturbs what else is in the file', () => {
  const v1 = spec({}, 1); const v2 = spec({}, 2);
  const mine = '# My rules\n\nAlways run the tests.\n';
  const once = withAgentBlock(mine, v1);
  assert.ok(once.startsWith(mine.trimEnd()));
  assert.equal(once.split(BLOCK_START).length - 1, 1);
  const after = `${once}\n## More of mine\n\nKeep this.\n`;
  const twice = withAgentBlock(after, v2);
  assert.equal(twice.split(BLOCK_START).length - 1, 1); assert.equal(twice.split(BLOCK_END).length - 1, 1);
  assert.ok(twice.includes(agentBlock(v2))); assert.equal(twice.includes(agentBlock(v1)), false);
  assert.equal(twice.replace(agentBlock(v2), agentBlock(v1)), after, 'something outside the block changed');
  assert.equal(withAgentBlock(twice, v2), twice, 'publishing the same version again changed the file');
  assert.ok(withAgentBlock('', v1).trim() === agentBlock(v1).trim());
});

test('finalize: nothing without a selection; version 1 from the first; the same direction again is the same version; another direction is the next', () => {
  const id = project([repo('solo').dir]);
  saveDesignSystem(id, exploration(null));
  assert.throws(() => finalizeProject(id), (e: unknown) => e instanceof DesignSystemError);
  assert.throws(() => publishProject(id), (e: unknown) => e instanceof DesignSystemError);
  assert.throws(() => finalizeProject('nope'), (e: unknown) => e instanceof DesignSystemError && e.status === 404);

  saveDesignSystem(id, exploration('a'));
  const one = finalizeProject(id, '2026-11-21T10:00:00Z').system!;
  assert.equal(one.version, 1); assert.equal(one.name, 'Direction a'); assert.deepEqual(one.from, { roundId: 'r1', variationId: 'a' });
  assert.deepEqual(one.files.map((f) => f.path.split('/')[1]), ['tokens.json', 'tokens.css', 'components.css', 'index.html', 'DESIGN-SYSTEM.md']);
  for (const f of one.files) assert.ok(f.bytes > 200, f.path);
  assert.ok(one.html.includes('Direction a'));
  assert.deepEqual(finalizeProject(id, '2026-11-21T11:00:00Z').system, one, 'finalizing the same direction again changed it');

  // A save from the page (a comment, a new round) keeps the system the server made.
  saveDesignSystem(id, exploration('a'));
  assert.deepEqual(getDesignSystem(id)!.system, one);

  saveDesignSystem(id, exploration('b'));
  const two = finalizeProject(id, '2026-11-21T12:00:00Z').system!;
  assert.equal(two.version, 2); assert.equal(two.name, 'Direction b'); assert.equal((two.spec as DesignSystemSpec).dark, true);
});

test('publish: every repo of the project gets the same files, in ONE commit of only those files, pushed — and nothing else in the repo is touched', () => {
  const repos = [repo('api', { remote: true }), repo('web', { remote: true }), repo('docs', { remote: true })];
  fs.writeFileSync(path.join(repos[0].dir, 'CLAUDE.md'), '# House rules\n\nRun the tests.\n'); sh(repos[0].dir, 'add', 'CLAUDE.md'); sh(repos[0].dir, 'commit', '-q', '-m', 'rules'); sh(repos[0].dir, 'push', '-q');
  fs.writeFileSync(path.join(repos[1].dir, 'AGENTS.md'), '# Agents\n'); sh(repos[1].dir, 'add', 'AGENTS.md'); sh(repos[1].dir, 'commit', '-q', '-m', 'agents'); sh(repos[1].dir, 'push', '-q');
  // Each repo has work in progress of its own: a modified tracked file, a staged new file, an untracked one.
  for (const r of repos) {
    fs.writeFileSync(path.join(r.dir, 'README.md'), '# edited, not committed\n');
    fs.writeFileSync(path.join(r.dir, 'staged.txt'), 'staged by the person\n'); sh(r.dir, 'add', 'staged.txt');
    fs.writeFileSync(path.join(r.dir, 'scratch.txt'), 'untracked\n');
  }

  const id = project(repos.map((r) => r.dir));
  assert.deepEqual([...projectRepos(id)].sort(), repos.map((r) => r.dir).sort());
  saveDesignSystem(id, exploration('a'));
  const system = finalizeProject(id).system!;
  const before = repos.map((r) => Number(sh(r.dir, 'rev-list', '--count', 'HEAD')));
  const out = publishProject(id, '2026-11-21T13:00:00Z').published!;

  assert.equal(out.version, 1);
  assert.deepEqual(out.repos.map((r) => r.repoPath).sort(), repos.map((r) => r.dir).sort());
  const expected = filesOf(system.spec as DesignSystemSpec);
  repos.forEach((r, i) => {
    const res = out.repos.find((x) => x.repoPath === r.dir)!;
    assert.equal(res.status, 'pushed', `${r.dir}: ${res.detail}`);
    assert.equal(res.branch, 'main');
    assert.equal(Number(sh(r.dir, 'rev-list', '--count', 'HEAD')), before[i] + 1);
    assert.equal(sh(r.dir, 'rev-parse', 'HEAD'), execFileSync('git', ['rev-parse', 'main'], { cwd: r.remote, encoding: 'utf8' }).trim());
    assert.ok(sh(r.dir, 'rev-parse', 'HEAD').startsWith(res.commit) && res.commit.length >= 7);
    assert.match(sh(r.dir, 'log', '-1', '--format=%s'), /design-system/);
    const committed = sh(r.dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort();
    const want = [...expected.map((f) => f.path), 'CLAUDE.md', ...(i === 1 ? ['AGENTS.md'] : [])].sort();
    assert.deepEqual(committed, want);
    for (const f of expected) assert.equal(fs.readFileSync(path.join(r.dir, f.path), 'utf8'), f.content, f.path);
    // Their work in progress is exactly as it was: still modified, still staged, still untracked.
    assert.equal(fs.readFileSync(path.join(r.dir, 'README.md'), 'utf8'), '# edited, not committed\n');
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: r.dir, encoding: 'utf8' }).split('\n').filter(Boolean).sort();
    assert.deepEqual(status, [' M README.md', '?? scratch.txt', 'A  staged.txt'].sort());
    assert.ok(fs.readFileSync(path.join(r.dir, 'CLAUDE.md'), 'utf8').includes(BLOCK_START));
  });
  assert.ok(fs.readFileSync(path.join(repos[0].dir, 'CLAUDE.md'), 'utf8').startsWith('# House rules\n\nRun the tests.'));
  assert.ok(fs.readFileSync(path.join(repos[1].dir, 'AGENTS.md'), 'utf8').includes(BLOCK_START));
  assert.equal(fs.existsSync(path.join(repos[2].dir, 'AGENTS.md')), false);
  assert.deepEqual(getDesignSystem(id)!.published, out);

  // Published again with nothing changed: no new commit anywhere.
  const again = publishProject(id).published!;
  for (const r of again.repos) assert.equal(r.status, 'unchanged', r.detail);
  repos.forEach((r, i) => assert.equal(Number(sh(r.dir, 'rev-list', '--count', 'HEAD')), before[i] + 1));

  // A new direction: version 2 replaces version 1 in every repo, in one more commit each.
  saveDesignSystem(id, exploration('b'));
  const sys2 = finalizeProject(id).system!;
  const v2 = publishProject(id).published!;
  assert.equal(v2.version, 2);
  repos.forEach((r, i) => {
    assert.equal(v2.repos.find((x) => x.repoPath === r.dir)!.status, 'pushed');
    assert.equal(Number(sh(r.dir, 'rev-list', '--count', 'HEAD')), before[i] + 2);
    for (const f of filesOf(sys2.spec as DesignSystemSpec)) assert.equal(fs.readFileSync(path.join(r.dir, f.path), 'utf8'), f.content, f.path);
    const claude = fs.readFileSync(path.join(r.dir, 'CLAUDE.md'), 'utf8');
    assert.equal(claude.split(BLOCK_START).length - 1, 1); assert.ok(claude.includes(agentBlock(sys2.spec as DesignSystemSpec)));
  });
});

test('publish: each repo is its own result — no upstream, a refused push, a missing folder, a folder that is not a repo — and one never stops the others', () => {
  const good = repo('good', { remote: true });
  const local = repo('local');
  const refused = repo('refused', { remote: true });
  // Someone else pushed to the remote first: a plain push is refused, and must not be forced.
  const other = path.join(ROOT, `other-${++n}`);
  execFileSync('git', ['clone', '-q', refused.remote, other]);
  sh(other, 'config', 'user.email', 'o@example.com'); sh(other, 'config', 'user.name', 'Other');
  fs.writeFileSync(path.join(other, 'theirs.txt'), 'x\n'); sh(other, 'add', '.'); sh(other, 'commit', '-q', '-m', 'theirs'); sh(other, 'push', '-q');
  const remoteHead = execFileSync('git', ['rev-parse', 'main'], { cwd: refused.remote, encoding: 'utf8' }).trim();
  const plain = path.join(ROOT, `plain-${++n}`); fs.mkdirSync(plain);
  const gone = path.join(ROOT, 'never-existed');

  const id = project([good.dir, local.dir, refused.dir, plain, gone]);
  saveDesignSystem(id, exploration('c'));
  finalizeProject(id);
  const res = new Map(publishProject(id).published!.repos.map((r) => [r.repoPath, r]));
  assert.equal(res.size, 5);
  assert.equal(res.get(good.dir)!.status, 'pushed', res.get(good.dir)!.detail);
  assert.equal(res.get(local.dir)!.status, 'committed', res.get(local.dir)!.detail);
  assert.equal(res.get(refused.dir)!.status, 'committed', res.get(refused.dir)!.detail);
  assert.equal(res.get(plain)!.status, 'failed');
  assert.equal(res.get(gone)!.status, 'failed');
  for (const r of res.values()) assert.ok(r.detail.length > 0, `${r.repoPath} gives no reason`);
  // The refused remote was not overwritten, and the commit is kept locally for the person to sort out.
  assert.equal(execFileSync('git', ['rev-parse', 'main'], { cwd: refused.remote, encoding: 'utf8' }).trim(), remoteHead);
  assert.match(sh(refused.dir, 'log', '-1', '--format=%s'), /design-system/);
  assert.match(sh(local.dir, 'log', '-1', '--format=%s'), /design-system/);
  // Nothing was written into a folder that is not a repo, and no folder was made for the missing one.
  assert.equal(fs.existsSync(path.join(plain, DESIGN_DIR)), false);
  assert.equal(fs.existsSync(gone), false);
  // A project with no repos at all says so.
  const empty = project([]);
  saveDesignSystem(empty, exploration('a')); finalizeProject(empty);
  assert.throws(() => publishProject(empty), (e: unknown) => e instanceof DesignSystemError);
  assert.equal(publishToRepo(gone, spec()).status, 'failed');
});

test.after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp folder */ } });

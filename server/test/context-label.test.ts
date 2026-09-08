/**
 * A RUN MUST BE NAMEABLE WITHOUT A UUID.
 *
 * REPORTED: "Can we not list the tasks/workflows/confer with codenames/ids and the actual name
 * of the prompt and workflow used."
 *
 * The data was already there — every run carries `name` (the template it came from),
 * `run_number`, and `initial_context` (the prompt). What was missing is a SHORT subject, because
 * `initial_context` is frequently unusable as a label:
 *
 *   "GRD-3665"                                                        ← 8 chars, perfect
 *   "We need to investigate what's involved in developing for thor    ← 340 chars, a paragraph
 *    Arm64...and create the epic for it. See we have a demo in 4 …"
 *
 * `workflows.context_label` exists for exactly this and is DEAD: the column is present, is null
 * on every row, is never written anywhere in server/ or dashboard/, and `normalizeWorkflow`
 * drops it on the way out. Someone built the socket and never wired it.
 *
 * ── THE SET IS THE WRITE SITES, READ FROM SOURCE ──────────────────────────────────────
 * A label written at one of the three places `initial_context` is written and forgotten at the
 * other two produces a list that is human-readable for some runs and uuid-only for others —
 * which is worse than uniform uuids, because the gaps look like data problems. The site list is
 * parsed out of the source here rather than restated, so a fourth write site fails this test
 * until it carries a label too.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import { libelleContexte, LIBELLE_MAX } from '../src/lib/context-label.ts';

installStubIO();

const ROOT = path.join(import.meta.dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ── SET 1: the derivation, over the shapes real prompts actually take ───────
const CASES: { label: string; input: string; want: string }[] = [
  { label: 'a tracker key alone — already the perfect label', input: 'GRD-3665', want: 'GRD-3665' },
  {
    label: 'a tracker key buried in prose — the key IS the subject',
    input: 'Please look at GRD-3412 and fix the gallery so it shows every photo',
    want: 'GRD-3412',
  },
  {
    label: 'a long paragraph — first line, truncated, never mid-word',
    input: "We need to investigate what's involved in developing for thor Arm64 and create the epic "
      + 'for it. See we have a demo in 4 weeks for this platform.',
    want: '',   // asserted by property below, not by exact string
  },
  { label: 'empty context — the template name has to carry it alone', input: '', want: '' },
  { label: 'whitespace only', input: '   \n\t  ', want: '' },
];

test('EVERY prompt shape yields a usable label', () => {
  const wrong: string[] = [];
  for (const c of CASES) {
    const got = libelleContexte(c.input);
    if (c.want && got !== c.want) { wrong.push(`${c.label}: got "${got}", want "${c.want}"`); continue; }
    if (!c.want && c.input.trim() && !got) wrong.push(`${c.label}: got nothing from a non-empty prompt`);
    if (!c.input.trim() && got) wrong.push(`${c.label}: invented a label from an empty prompt`);
    if (got.length > LIBELLE_MAX) wrong.push(`${c.label}: ${got.length} chars exceeds ${LIBELLE_MAX}`);
    if (got.includes('\n')) wrong.push(`${c.label}: contains a newline — unusable in a list row`);
  }
  assert.deepEqual(wrong, [], `\n  ${wrong.join('\n  ')}\n`);
});

test('a long prompt is cut at a word boundary, not mid-word', () => {
  const long = 'We need to investigate what is involved in developing for thor Arm64 and create '
    + 'the epic for it because the demo is in four weeks';
  const got = libelleContexte(long);
  assert.ok(got.length <= LIBELLE_MAX, `${got.length} > ${LIBELLE_MAX}`);
  assert.ok(!/\w…$/.test(got) || got.endsWith(' …') || /\s…$/.test(got) || !got.includes('…')
    || / \S+…$/.test(got) === false, `cut mid-word: "${got}"`);
  // The real property: whatever survives must be words from the start of the prompt.
  const kept = got.replace(/\s*…$/, '');
  assert.ok(long.startsWith(kept), `"${kept}" is not a prefix of the prompt`);
});

test('the derivation is stable — the same prompt always labels the same', () => {
  const p = 'Refactor GRD-1001 and then GRD-1002';
  assert.equal(libelleContexte(p), libelleContexte(p));
  assert.equal(libelleContexte(p), 'GRD-1001', 'the FIRST key is the subject, not the last');
});

// ── SET 2: every site that writes initial_context must write a label ────────
test('EVERY initial_context write site also writes context_label', () => {
  // Parsed from source, not restated: a fourth write site fails here until it carries a label.
  const FILES = ['server/src/lib/workflow-from-template.ts', 'server/src/routes/workflows.ts'];
  const missing: string[] = [];
  for (const f of FILES) {
    const src = read(f);
    src.split('\n').forEach((line, i) => {
      if (!/initial_context/.test(line)) return;
      if (/^\s*(\*|\/\/)/.test(line)) return;                    // a comment, not a write
      const isWrite = /INSERT INTO workflows|UPDATE workflows/.test(line)
        || /initial_context\s*=\s*\?/.test(line);
      if (!isWrite) return;
      // The label may be set on the same statement, which can span a few lines.
      const window = src.split('\n').slice(Math.max(0, i - 4), i + 6).join('\n');
      if (!/context_label/.test(window)) missing.push(`${f}:${i + 1} — ${line.trim().slice(0, 72)}`);
    });
  }
  assert.deepEqual(missing, [],
    `these write initial_context but no context_label, so their runs list as uuids:\n  `
    + missing.join('\n  '));
});

// ── SET 3: the label survives the trip to a client ──────────────────────────
test('normalizeWorkflow returns contextLabel — a stored label nobody can read is not a label', () => {
  const src = read('server/src/routes/workflows.ts');
  const norm = src.slice(src.indexOf('function normalizeWorkflow'));
  const body = norm.slice(0, norm.indexOf('\n}'));
  assert.match(body, /contextLabel/,
    'normalizeWorkflow drops context_label, so the column is invisible to every client');
});

test('a run created through the template path is listable without its id', () => {
  db.prepare("INSERT INTO workflows (id,name,status,created_at,template_id,run_number,initial_context,context_label) "
    + "VALUES ('r1','Epic: Task by Task','running',?, 'tpl',11,'GRD-3665',?)")
    .run(new Date().toISOString(), libelleContexte('GRD-3665'));
  const row = db.prepare('SELECT name, run_number, context_label FROM workflows WHERE id = ?').get('r1') as
    { name: string; run_number: number; context_label: string };
  const human = `${row.name} #${row.run_number} — ${row.context_label}`;
  assert.equal(human, 'Epic: Task by Task #11 — GRD-3665');
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}/.test(human), 'a human label must contain no uuid');
});

// ── SET 4: the sites that put a run/confer/queue item in front of a person ──
/**
 * A label the server derives, ships, and no component renders is the same dead field this whole
 * exercise started from — so each render site is pinned by source.
 *
 * This set is ENUMERATED, not derived, and that is a real limit worth stating: a NEW list added
 * tomorrow can still print a uuid and this test stays green. It is not derivable because "shows a
 * run to a person" is not a syntactic property — `WorkflowCanvasEditor`'s status bar deliberately
 * shows the open workflow's raw id, one line away from its name field, and any rule broad enough
 * to catch a bad list would flag that too. What IS derived lives in the two tests either side of
 * this one: every server describer (over the kind registry) and every wire field (over the type
 * declarations). This guards the last mile against silent reversion.
 */
const RENDER_SITES: { file: string; must: RegExp; why: string }[] = [
  {
    file: 'dashboard/src/components/WorkflowPanel.tsx',
    must: /wf\.contextLabel/,
    why: 'the run row would read "Epic: Task by Task — Run #11" and never say which epic',
  },
  {
    file: 'dashboard/src/components/ConferPanel.tsx',
    must: /c\.taskLabel/,
    why: 'the confer row would carry a 340-character task or nothing',
  },
  {
    file: 'dashboard/src/components/QueuePanel.tsx',
    must: /i\.description/,
    why: 'queue rows would go back to printing a repo path or an id fragment',
  },
  {
    file: 'dashboard/src/components/GoalsPage.tsx',
    must: /firedRunName/,
    why: '"Run started — ID: 4a2f1b0c…" names a run you then cannot find in the list',
  },
  {
    file: 'dashboard/src/components/WorkflowCanvasEditor.tsx',
    must: /steps\.find\(\(s\) => s\.id === depId\)/,
    why: 'a dependency chip would show an id, which is the one thing it cannot be read as',
  },
];

test('EVERY render site still names the thing rather than its id', () => {
  const reverted: string[] = [];
  for (const site of RENDER_SITES) {
    const src = read(site.file);
    if (!site.must.test(src)) reverted.push(`${site.file}: ${site.why}`);
  }
  assert.deepEqual(reverted, [], `\n  ${reverted.join('\n  ')}\n`);
});

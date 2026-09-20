/**
 * THE DIGEST IS THE DELIVERABLE, AND IT LOOKS THE SAME EVERY MORNING.
 *
 * Reported as: "on the Daily Digest ... we only want to see the digest at the end, not the
 * report that we do for all the other workflows on top of it. This digest should look like a
 * newspaper and with the same content we already have, the template should be create so it
 * looks the same every single time. Also ... add a AI noise Section on reddit by number of
 * most popular reddit so we see what people are talking about."
 *
 * Three separate defects, one workflow:
 *
 *  1. TWO DOCUMENTS, ONE RUN. Every template got a Workflow Completion Report step, this one
 *     included, so a digest run produced the digest AND a generic report about the digest.
 *     The render step was even told "do NOT open it ... the Workflow Completion Report embeds
 *     this digest and is the one window", which is backwards for a workflow whose entire
 *     output IS the document. Deleting the step from the database does not hold: addReportSteps
 *     re-adds it on every boot, so the exemption has to live in code.
 *
 *  2. IT LOOKED DIFFERENT EVERY DAY. The render step asked an agent to write the HTML from a
 *     prose description of five sections. Prose cannot pin a layout, so two runs of the same
 *     workflow produced two different papers. A fixed renderer over structured data can.
 *
 *  3. NO READER VOICE. The digest reported what shipped, never what people were saying.
 *
 * SET-BASED over DIGEST_SECTIONS, the section registry, and over the template's own steps —
 * because a renderer tested on the one section someone had in mind silently drops the rest,
 * which is exactly how a newspaper loses its back page.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.ts';
import { isReportStep } from '../src/lib/workflow-report.ts';
import {
  DIGEST_SECTIONS, REPORT_EXEMPT_TEMPLATES, renderDigestHtml, type DigestData,
} from '../src/lib/digest-template.ts';

const DIGEST = 'Daily AI Research Digest';

/** A day's data with every section populated, so a dropped section is visible. */
function fullDay(): DigestData {
  return {
    date: '2026-09-20',
    throughLine: 'Quiet on releases, loud on agent tooling.',
    itemCount: 6,
    actOnIt: [{ title: 'Pin your MCP server version', why: 'A breaking change shipped.', action: 'Pin it today', url: 'https://example.com/a' }],
    worthKnowing: [{ title: 'New eval harness', what: 'Runs offline.', url: 'https://example.com/b' }],
    background: [{ title: 'Funding round', url: 'https://example.com/c' }],
    aiNoise: [
      { subreddit: 'r/LocalLLaMA', title: 'Qwen3 coder is surprisingly good', score: 4210, comments: 830, url: 'https://reddit.com/x', takeaway: 'Local coding models are the talk.' },
      { subreddit: 'r/MachineLearning', title: 'Why RL on quantised rollouts drifts', score: 1980, comments: 210, url: 'https://reddit.com/y', takeaway: 'Drift, not variance.' },
    ],
    dropped: [{ title: 'Rumoured model', why: 'No primary source.' }],
  };
}

// ── 1. One document per run ────────────────────────────────────────────────────────────

test('the digest template carries NO Workflow Completion Report step', () => {
  const tpl = db.prepare(
    'SELECT id FROM workflows WHERE template_id IS NULL AND name = ?',
  ).get(DIGEST) as { id: string } | undefined;
  assert.ok(tpl, `template "${DIGEST}" is missing`);

  const steps = db.prepare(
    'SELECT name, executor_config FROM workflow_steps WHERE workflow_id = ?',
  ).all(tpl!.id) as { name: string; executor_config: string }[];

  const report = steps.filter((s) => isReportStep(JSON.parse(s.executor_config || '{}')));
  assert.deepEqual(report.map((s) => s.name), [],
    'the digest run still ends with a generic completion report on top of the digest — '
    + 'two documents for one run, which is the whole complaint');
});

test('the exemption is a registry, so a boot cannot put the step back', () => {
  // addReportSteps runs on every boot. A one-off DELETE would be undone by morning.
  assert.ok(REPORT_EXEMPT_TEMPLATES.includes(DIGEST),
    'the digest is not in the exemption registry, so the next boot re-adds the report step');
  // And it must not exempt everything: the report step is right for ordinary workflows.
  const tpls = db.prepare('SELECT COUNT(*) c FROM workflows WHERE template_id IS NULL').get() as { c: number };
  assert.ok(REPORT_EXEMPT_TEMPLATES.length < tpls.c,
    'the exemption swallowed every template — ordinary runs still need their report');
});

test('every OTHER template still gets its report step', () => {
  const missing = (db.prepare(
    `SELECT w.name FROM workflows w
      WHERE w.template_id IS NULL
        AND w.name NOT IN (${REPORT_EXEMPT_TEMPLATES.map(() => '?').join(',')})
        AND EXISTS (SELECT 1 FROM workflow_steps s WHERE s.workflow_id = w.id)
        AND NOT EXISTS (SELECT 1 FROM workflow_steps s WHERE s.workflow_id = w.id
                        AND s.executor_config LIKE '%workflow-report%')`,
  ).all(...REPORT_EXEMPT_TEMPLATES) as { name: string }[]).map((r) => r.name);
  assert.deepEqual(missing, [], `these templates lost their completion report: ${missing.join(', ')}`);
});

// ── 2. The same paper every morning ────────────────────────────────────────────────────

test('the renderer emits EVERY section in the registry, in order', () => {
  assert.ok(DIGEST_SECTIONS.length >= 5, 'the section registry is suspiciously small');
  const html = renderDigestHtml(fullDay());
  const missing = DIGEST_SECTIONS.filter((s) => !html.includes(s.heading));
  assert.deepEqual(missing.map((s) => s.id), [],
    `the renderer dropped sections: ${missing.map((s) => s.heading).join(', ')}`);

  // Order matters in a newspaper — the front page cannot land after the back page.
  const positions = DIGEST_SECTIONS.map((s) => html.indexOf(s.heading));
  const sorted = [...positions].sort((a, b) => a - b);
  assert.deepEqual(positions, sorted, 'sections rendered out of registry order');
});

test('the same data renders byte-identical HTML — that is what "same every time" means', () => {
  const a = renderDigestHtml(fullDay());
  const b = renderDigestHtml(fullDay());
  assert.equal(a, b, 'two renders of identical data differ, so the paper cannot look the same twice');
});

test('a quiet day still renders every section, saying so rather than vanishing', () => {
  const quiet: DigestData = {
    date: '2026-09-21', throughLine: 'Nothing worth acting on.', itemCount: 0,
    actOnIt: [], worthKnowing: [], background: [], aiNoise: [], dropped: [],
  };
  const html = renderDigestHtml(quiet);
  const missing = DIGEST_SECTIONS.filter((s) => !html.includes(s.heading));
  assert.deepEqual(missing.map((s) => s.id), [],
    'an empty section disappeared instead of saying it was quiet — the layout must not move');
});

test('the page is self-contained and works in both themes', () => {
  const html = renderDigestHtml(fullDay());
  assert.ok(!/<script|<link |@import|src=["']http/i.test(html), 'the page loads something external');
  assert.match(html, /prefers-color-scheme:\s*dark/, 'no dark mode');
  assert.match(html, /body\s*\{[^}]*background/, 'body has no explicit background');
});

test('user-supplied text is escaped, not interpolated raw', () => {
  const d = fullDay();
  d.actOnIt[0].title = '<script>alert(1)</script>';
  const html = renderDigestHtml(d);
  assert.ok(!html.includes('<script>alert(1)</script>'), 'a title was injected into the page unescaped');
  assert.ok(html.includes('&lt;script&gt;'), 'the title was dropped rather than escaped');
});

// ── 3. AI noise ────────────────────────────────────────────────────────────────────────

test('the AI noise section exists and ranks Reddit by popularity', () => {
  const noise = DIGEST_SECTIONS.find((s) => s.id === 'ai-noise');
  assert.ok(noise, 'no AI noise section in the registry');

  const d = fullDay();
  // Deliberately out of order: the renderer must rank, not trust the input.
  d.aiNoise = [
    { subreddit: 'r/a', title: 'quiet post', score: 12, comments: 3, url: 'https://reddit.com/1', takeaway: 'x' },
    { subreddit: 'r/b', title: 'loud post', score: 9001, comments: 400, url: 'https://reddit.com/2', takeaway: 'y' },
  ];
  const html = renderDigestHtml(d);
  assert.ok(html.indexOf('loud post') < html.indexOf('quiet post'),
    'AI noise is not ordered by popularity — "by number of most popular" is the whole ask');
  assert.match(html, /9,?001/, 'the score is not shown, so the reader cannot see how loud it was');
});

test('the scan step actually gathers Reddit, or the section renders empty forever', () => {
  const tpl = db.prepare('SELECT id FROM workflows WHERE template_id IS NULL AND name = ?')
    .get(DIGEST) as { id: string };
  const scan = db.prepare(
    'SELECT executor_config FROM workflow_steps WHERE workflow_id = ? AND name = ?',
  ).get(tpl.id, 'Scan the Web') as { executor_config: string } | undefined;
  assert.ok(scan, 'the scan step is missing');
  const prompt = String(JSON.parse(scan!.executor_config).prompt || '');
  assert.match(prompt, /reddit/i,
    'nothing tells the scan step to collect Reddit, so the AI noise section is permanently empty');
});

test('the render step opens the digest — it is the one window now', () => {
  const tpl = db.prepare('SELECT id FROM workflows WHERE template_id IS NULL AND name = ?')
    .get(DIGEST) as { id: string };
  const render = db.prepare(
    'SELECT executor_config FROM workflow_steps WHERE workflow_id = ? AND name = ?',
  ).get(tpl.id, 'Render the Digest') as { executor_config: string };
  const prompt = String(JSON.parse(render.executor_config).prompt || '');
  assert.ok(!/do NOT open it/i.test(prompt),
    'the render step is still told not to open the digest, which was only correct while a '
    + 'completion report was going to embed it');
  assert.match(prompt, /\bopen\b/i, 'nothing opens the digest, so the run ends with no window at all');
});

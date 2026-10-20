/**
 * AI FILM DAILY — the same paper, on one beat.
 *
 * Asked for as: "create another AI daily, but focused ONLY on AI filmmaking ... same approach,
 * look at the news, websites like Theoretically Media, Curious Refuge, Runway updates, Artlist
 * ... newsletters from specific model vendors — Kling, Luma, Hailuo/MiniMax, Adobe Firefly ...
 * reddit groups on the subject. Exactly the same workflow as the original AI daily."
 *
 * "Exactly the same workflow" is the constraint that shapes these tests. The film digest is
 * checked AGAINST the AI digest, step by step, rather than against a list written here — so if
 * the AI digest later gains a step, this file fails until the film edition gets it too.
 *
 * And the second paper must not disturb the first: the AI Daily renders byte-identically to
 * what it rendered before editions existed, and the two runs never write the same file.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.ts';
import { isReportStep } from '../src/lib/workflow-report.ts';
import {
  DIGEST_EDITIONS, REPORT_EXEMPT_TEMPLATES, renderDigestHtml, type DigestData,
} from '../src/lib/digest-template.ts';

const AI = 'Daily AI Research Digest';
const FILM = 'Daily AI Filmmaking Digest';

type Step = { name: string; executor_type: string; depends_on: string; executor_config: string; id: string };

function stepsOf(name: string): Step[] {
  const tpl = db.prepare('SELECT id FROM workflows WHERE template_id IS NULL AND name = ?')
    .get(name) as { id: string } | undefined;
  assert.ok(tpl, `template "${name}" is missing`);
  return db.prepare(
    'SELECT id, name, executor_type, depends_on, executor_config FROM workflow_steps WHERE workflow_id = ? ORDER BY position_y',
  ).all(tpl!.id) as Step[];
}

const prompts = (name: string) => stepsOf(name).map((s) => String(JSON.parse(s.executor_config).prompt ?? '')).join('\n');

function day(): DigestData {
  return {
    date: '2026-09-26',
    throughLine: 'Camera control is the new battleground.',
    itemCount: 3,
    actOnIt: [{ title: 'Runway ships a new model', why: 'Better consistency.', action: 'Re-test your hero shot', url: 'https://example.com/a' }],
    worthKnowing: [{ title: 'Kling price change', what: 'Credits cost more.', url: 'https://example.com/b' }],
    background: [],
    aiNoise: [{ subreddit: 'r/aivideo', title: 'A short made entirely in Veo', score: 5000, comments: 400, url: 'https://reddit.com/x', takeaway: 'People want longer takes.' }],
    dropped: [],
  };
}

// ── Same workflow ──────────────────────────────────────────────────────────────────────

test('the film digest has exactly the AI digest\'s steps, types and wiring', () => {
  const shape = (name: string) => {
    const steps = stepsOf(name);
    const nameOf = new Map(steps.map((s) => [s.id, s.name]));
    return steps.map((s) => ({
      name: s.name,
      type: s.executor_type,
      deps: (JSON.parse(s.depends_on) as string[]).map((d) => nameOf.get(d)),
    }));
  };
  assert.deepEqual(shape(FILM), shape(AI));
});

test('the film digest is its own deliverable — exempt, with no completion report step', () => {
  assert.ok(REPORT_EXEMPT_TEMPLATES.includes(FILM), 'the next boot would add a completion report on top of the paper');
  const report = stepsOf(FILM).filter((s) => isReportStep(JSON.parse(s.executor_config || '{}')));
  assert.deepEqual(report.map((s) => s.name), []);
});

// ── Only filmmaking, from the sources that were named ─────────────────────────────────

test('the scan names every source that was asked for', () => {
  const text = prompts(FILM);
  const missing = ['Theoretically Media', 'Curious Refuge', 'Runway', 'Artlist', 'Kling', 'Luma', 'Hailuo', 'MiniMax', 'Firefly', 'Reddit']
    .filter((s) => !text.includes(s));
  assert.deepEqual(missing, [], `the film scan never mentions: ${missing.join(', ')}`);
});

test('the film digest does not inherit the AI digest\'s coding-agent beat', () => {
  const text = prompts(FILM);
  for (const offBeat of ['r/LocalLLaMA', 'AGENT + CODING TOOLING', 'they build AI agent orchestration']) {
    assert.ok(!text.includes(offBeat), `"${offBeat}" belongs to the AI digest, not the filmmaking one`);
  }
});

test('the two runs never write the same file', () => {
  const paths = (name: string) => new Set(prompts(name).match(/\.neoncore\/digests\/[\w.-]+/g) ?? []);
  const ai = paths(AI), film = paths(FILM);
  assert.ok(film.size >= 3, `expected the film digest to name its json, html and index files, got ${[...film]}`);
  const shared = [...film].filter((p) => ai.has(p));
  assert.deepEqual(shared, [], 'the film run would overwrite the AI run\'s files');
});

// ── Same paper, its own masthead ───────────────────────────────────────────────────────

test('every edition renders its own masthead and title', () => {
  for (const [id, ed] of Object.entries(DIGEST_EDITIONS)) {
    const html = renderDigestHtml({ ...day(), edition: id as DigestData['edition'] });
    assert.ok(html.includes(`<title>${ed.masthead} — 2026-09-26</title>`), `${id}: wrong <title>`);
    assert.ok(html.includes(`<h1>${ed.masthead}</h1>`), `${id}: wrong masthead`);
    assert.ok(html.includes(`<h2>${ed.noiseHeading}</h2>`), `${id}: wrong reddit heading`);
  }
  assert.equal(DIGEST_EDITIONS.film.masthead, 'AI Film Daily');
});

test('the film render step checks for the film masthead', () => {
  assert.ok(prompts(FILM).includes('<title>AI Film Daily'), 'the render check would pass on the wrong paper');
  assert.ok(prompts(FILM).includes('"edition": "film"'), 'the data never asks for the film edition');
});

test('the AI Daily is untouched: no edition renders exactly as the ai edition', () => {
  const plain = renderDigestHtml(day());
  assert.equal(plain, renderDigestHtml({ ...day(), edition: 'ai' }));
  assert.ok(plain.includes('<title>AI Daily — 2026-09-26</title>'));
  assert.ok(plain.includes('<h2>AI NOISE</h2>'));
});

test('an unknown edition falls back to the AI Daily rather than breaking the paper', () => {
  const html = renderDigestHtml({ ...day(), edition: 'nonsense' as DigestData['edition'] });
  assert.ok(html.includes('<title>AI Daily — 2026-09-26</title>'));
});

/**
 * THE RECORDER — tests from how people actually use the app (scope §3.3).
 *
 * A small script, served at GET /qa/recorder.js?target=<id>, is added to the STAGING app. It
 * records navigation, clicks, typing and form submits, and posts them in batches here. Privacy is
 * enforced twice — in the browser and again on intake, so a modified script cannot store more:
 *   · a password field, or any field marked [data-qa-sensitive], is never recorded at all;
 *   · typed text is masked unless the field is marked [data-qa-record].
 *
 * Journeys: each session becomes a sequence of normalised steps; identical sequences are one
 * journey, ranked by how many sessions took it. `generate` turns the top journeys into
 * plain-language tests (test data in place of what was typed), each tagged with its journey's
 * signature, which is how coverage knows which journeys have a test.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import db from '../../db.js';
import { normalisePage } from './findings.js';
import { createTest, getTarget, listTests, type QaTest } from './store.js';
import { QaError } from './types.js';

const nowIso = () => new Date().toISOString();
export const MASK = '•••';
/** At most this many events per session are kept. */
export const MAX_EVENTS = 2000;

export interface RecordedEvent {
  t: 'nav' | 'click' | 'input' | 'submit';
  path: string;
  label?: string;
  field?: string;
  value?: string;
  ts?: number;
}

/**
 * The target's recorder key, made the first time it is needed. The recorder runs in the app under
 * test, so it cannot hold the fleet token: its intake is public (lib/auth.ts) and accepts only
 * this key, which reaches the app only inside the snippet a person pastes into it.
 */
export function recorderKeyOf(targetId: string): string {
  const row = db.prepare('SELECT recorder_key FROM qa_targets WHERE id = ?').get(targetId) as { recorder_key: string } | undefined;
  if (!row) throw new QaError('target not found', 404);
  if (row.recorder_key) return row.recorder_key;
  const key = randomBytes(24).toString('hex');
  db.prepare('UPDATE qa_targets SET recorder_key = ? WHERE id = ?').run(key, targetId);
  return key;
}

/** Constant-time: is `key` this target's recorder key? */
export function recorderKeyMatches(targetId: string, key: unknown): boolean {
  if (typeof key !== 'string' || !key) return false;
  const want = Buffer.from(recorderKeyOf(targetId));
  const got = Buffer.from(key);
  return got.length === want.length && timingSafeEqual(got, want);
}

export function startSession(targetId: string, key?: unknown): { id: string } {
  if (!getTarget(targetId)) throw new QaError('target not found', 404);
  if (!recorderKeyMatches(targetId, key)) throw new QaError('wrong recorder key for this target', 403);
  const id = randomUUID(); const now = nowIso();
  db.prepare('INSERT INTO qa_sessions (id, target_id, created_at, updated_at) VALUES (?,?,?,?)').run(id, targetId, now, now);
  return { id };
}

/** One event as stored: sensitive fields dropped, typed text masked unless the field opted in. */
export function sanitiseEvent(e: Record<string, unknown>): RecordedEvent | null {
  const t = String(e.t ?? '');
  if (!['nav', 'click', 'input', 'submit'].includes(t)) return null;
  const clip = (v: unknown, n = 200) => (typeof v === 'string' ? v.slice(0, n) : undefined);
  const out: RecordedEvent = { t: t as RecordedEvent['t'], path: normalisePage(String(e.path ?? '/')) };
  const label = clip(e.label); if (label) out.label = label;
  const field = clip(e.field); if (field) out.field = field;
  if (typeof e.ts === 'number') out.ts = e.ts;
  if (t === 'input') {
    if (e.sensitive === true || String(e.inputType ?? '').toLowerCase() === 'password') return null;
    out.value = e.record === true ? clip(e.value) ?? '' : MASK;
  }
  return out;
}

export function addEvents(sessionId: string, events: unknown, key?: unknown): { stored: number } {
  const row = db.prepare('SELECT events, target_id FROM qa_sessions WHERE id = ?').get(sessionId) as { events: string; target_id: string } | undefined;
  if (!row) throw new QaError('session not found', 404);
  if (!recorderKeyMatches(row.target_id, key)) throw new QaError('wrong recorder key for this session', 403);
  if (!Array.isArray(events)) throw new QaError('events must be an array');
  const clean = events.map((e) => (e && typeof e === 'object' ? sanitiseEvent(e as Record<string, unknown>) : null)).filter((e): e is RecordedEvent => e !== null);
  const all = [...(JSON.parse(row.events) as RecordedEvent[]), ...clean].slice(0, MAX_EVENTS);
  db.prepare('UPDATE qa_sessions SET events = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(all), nowIso(), sessionId);
  return { stored: clean.length };
}

// ── journeys ───────────────────────────────────────────────────────────────────────────

const norm = (s: string | undefined) => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** A session's steps, normalised: repeated typing into one field is one step, a repeated page visit one goto. */
export function stepsOf(events: readonly RecordedEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    const s = e.t === 'nav' ? `goto ${e.path}`
      : e.t === 'click' ? `click ${norm(e.label)}`
      : e.t === 'input' ? `fill ${norm(e.field || e.label)}`
      : `submit ${norm(e.label || e.path)}`;
    if (out[out.length - 1] !== s) out.push(s);
  }
  return out;
}

export function journeySig(steps: readonly string[]): string {
  return createHash('sha256').update(steps.join('\n')).digest('hex').slice(0, 16);
}

export interface Journey { sig: string; steps: string[]; count: number; testId: string | null }

/** Every journey of a target, most-travelled first, with the test that covers it (if any). */
export function mineJourneys(targetId: string): Journey[] {
  const rows = db.prepare('SELECT events FROM qa_sessions WHERE target_id = ?').all(targetId) as { events: string }[];
  const by = new Map<string, Journey>();
  for (const r of rows) {
    const steps = stepsOf(JSON.parse(r.events) as RecordedEvent[]);
    if (steps.length < 2) continue;
    const sig = journeySig(steps);
    const j = by.get(sig) ?? { sig, steps, count: 0, testId: null };
    j.count++;
    by.set(sig, j);
  }
  const tests = listTests(targetId);
  for (const j of by.values()) j.testId = tests.find((t) => t.journeySig === j.sig)?.id ?? null;
  return [...by.values()].sort((a, b) => b.count - a.count || a.sig.localeCompare(b.sig));
}

export function coverageOf(targetId: string): { journeys: Journey[]; covered: number; total: number } {
  const journeys = mineJourneys(targetId);
  return { journeys, covered: journeys.filter((j) => j.testId).length, total: journeys.length };
}

/** A journey as sentences: what was typed is replaced by test data; it ends checking where it ended. */
export function sentencesFor(steps: readonly string[]): string[] {
  const out: string[] = [];
  let lastPage = '/';
  for (const s of steps) {
    const [verb, ...rest] = s.split(' ');
    const what = rest.join(' ');
    if (verb === 'goto') { out.push(`Go to ${what}.`); lastPage = what; }
    else if (verb === 'click') out.push(`Click "${what}".`);
    else if (verb === 'fill') out.push(`Fill in "${what}" with test data.`);
    else out.push(`Submit the form.`);
  }
  out.push(`Check that the page is ${lastPage}.`);
  return out;
}

/** Turn the top `limit` journeys that have no test yet into tests. */
export function generateFromJourneys(targetId: string, limit = 5): { created: QaTest[]; journeys: number } {
  const journeys = mineJourneys(targetId);
  const created: QaTest[] = [];
  for (const j of journeys.filter((x) => !x.testId).slice(0, Math.max(1, limit))) {
    created.push(createTest({ targetId, name: `Journey: ${j.steps.slice(0, 3).join(' → ')}`.slice(0, 120), sentences: sentencesFor(j.steps) }, { source: 'recorder', journeySig: j.sig }));
  }
  return { created, journeys: journeys.length };
}

// ── the script ──────────────────────────────────────────────────────────────────────────

/** The capture script for one target. Masks in the browser as well; the server masks again. */
export function recorderScript(targetId: string, origin: string, key: string): string {
  return `/* NeonCore QA recorder — staging only. Records navigation, clicks, typing and submits.
   Passwords and [data-qa-sensitive] fields are never recorded; typed text is masked unless the field is [data-qa-record]. */
(function () {
  if (window.__neoncoreQa) return; window.__neoncoreQa = true;
  var API = ${JSON.stringify(origin)} + '/api/qa/sessions';
  var TARGET = ${JSON.stringify(targetId)};
  var RKEY = ${JSON.stringify(key)};
  var KEY = 'neoncore.qa.session.' + TARGET;
  var queue = [], sid = null;
  try { sid = sessionStorage.getItem(KEY); } catch (e) {}
  function start() {
    if (sid) return Promise.resolve(sid);
    return fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetId: TARGET, key: RKEY }) })
      .then(function (r) { return r.json(); }).then(function (j) { sid = j.id; try { sessionStorage.setItem(KEY, sid); } catch (e) {} return sid; });
  }
  function flush() {
    if (!queue.length) return; var batch = queue; queue = [];
    start().then(function (id) {
      var body = JSON.stringify({ key: RKEY, events: batch });
      if (navigator.sendBeacon && document.visibilityState === 'hidden') navigator.sendBeacon(API + '/' + id + '/events', new Blob([body], { type: 'application/json' }));
      else fetch(API + '/' + id + '/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true });
    }).catch(function () {});
  }
  function labelOf(el) {
    if (!el) return '';
    var l = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'));
    if (l) return l;
    if (el.labels && el.labels[0]) return el.labels[0].innerText;
    return (el.innerText || el.value || el.name || el.id || el.tagName || '').toString().trim().slice(0, 80);
  }
  function sensitive(el) { return !!(el && (el.type === 'password' || (el.closest && el.closest('[data-qa-sensitive]')))); }
  function push(e) { e.path = location.pathname; e.ts = Date.now(); queue.push(e); if (queue.length >= 20) flush(); }
  push({ t: 'nav' });
  var last = location.pathname;
  setInterval(function () { if (location.pathname !== last) { last = location.pathname; push({ t: 'nav' }); } flush(); }, 1000);
  document.addEventListener('click', function (ev) {
    var el = ev.target && ev.target.closest ? ev.target.closest('a,button,[role=button],input[type=submit],input[type=checkbox],select,[data-qa-label]') : null;
    if (el) push({ t: 'click', label: el.getAttribute('data-qa-label') || labelOf(el) });
  }, true);
  document.addEventListener('change', function (ev) {
    var el = ev.target; if (!el || !('value' in el)) return;
    if (sensitive(el)) return;
    var record = !!(el.closest && el.closest('[data-qa-record]'));
    push({ t: 'input', field: labelOf(el), inputType: el.type || '', record: record, value: record ? String(el.value).slice(0, 200) : '${MASK}' });
  }, true);
  document.addEventListener('submit', function (ev) { push({ t: 'submit', label: labelOf(ev.target) }); flush(); }, true);
  window.addEventListener('pagehide', flush);
})();
`;
}

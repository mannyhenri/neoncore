#!/usr/bin/env node
/**
 * The QA section from the command line, for CI (docs/plans/qa-section.md).
 *
 *   node scripts/qa.mjs run      --target <name|id> [--test <name|id> ...] [--strict]
 *   node scripts/qa.mjs explore  --target <name|id> [--goal "focus on approvals"]
 *   node scripts/qa.mjs generate --target <name|id>
 *   node scripts/qa.mjs report   --run <id> [--out report.html]
 *
 * Starts the run on the NeonCore server (NEONCORE_URL, default http://localhost:4040), waits for it
 * to finish and prints one line per test. Exit codes: 0 passed (a run that passed with repairs
 * counts as passed unless --strict), 1 failed, 2 could not run (bad arguments, server unreachable,
 * unknown target, timed out).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = (process.env.NEONCORE_URL || 'http://localhost:4040').replace(/\/$/, '');
const DONE = new Set(['passed', 'passed_with_repair', 'failed', 'error']);

function token() {
  const env = (process.env.NEONCORE_FLEET_TOKEN || '').trim();
  if (env) return env;
  try { return readFileSync(join(homedir(), '.neoncore', 'token'), 'utf8').trim(); } catch { return ''; }
}

async function api(method, path, body) {
  const t = token();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
  return path.endsWith('.html') ? text : JSON.parse(text || 'null');
}

function args(argv) {
  const out = { _: [], test: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    if (key === 'strict') { out.strict = true; continue; }
    const val = argv[++i];
    if (val === undefined) throw new Error(`--${key} needs a value`);
    if (key === 'test') out.test.push(val); else out[key] = val;
  }
  return out;
}

const pick = (list, ref, what) => {
  const hit = list.find((x) => x.id === ref) ?? list.find((x) => x.name === ref);
  if (!hit) throw new Error(`no ${what} "${ref}" (have: ${list.map((x) => x.name).join(', ') || 'none'})`);
  return hit;
};

async function waitFor(runId, minutes) {
  const until = Date.now() + minutes * 60_000;
  for (;;) {
    const run = await api('GET', `/api/qa/runs/${runId}`);
    if (DONE.has(run.status)) return run;
    if (Date.now() > until) throw new Error(`run ${runId} still ${run.status} after ${minutes} min`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

function print(run) {
  for (const r of run.results ?? []) {
    const step = r.failedStep !== undefined && r.failedStep !== null ? ` at step ${Number(r.failedStep) + 1}` : '';
    console.log(`${r.status.padEnd(18)} ${r.testName ?? r.testId}${step}${r.error ? ` — ${r.error}` : ''}`);
  }
  for (const f of run.findings ?? []) console.log(`${(f.severity || '').padEnd(8)} ${f.title}${f.seenCount > 1 ? ` (×${f.seenCount})` : ''}`);
  console.log(`\n${run.kind} ${run.status} · AI calls ${run.aiCalls ?? 0} · ${BASE}/api/qa/runs/${run.id}/report.html`);
}

async function main() {
  const a = args(process.argv.slice(2));
  const cmd = a._[0];
  if (cmd === 'report') {
    if (!a.run) throw new Error('report needs --run <id>');
    const html = await api('GET', `/api/qa/runs/${a.run}/report.html`);
    if (a.out) { writeFileSync(a.out, html); console.log(`wrote ${a.out}`); } else process.stdout.write(html);
    return 0;
  }
  if (!['run', 'explore', 'generate'].includes(cmd)) throw new Error('usage: qa.mjs run|explore|generate|report …');
  if (!a.target) throw new Error(`${cmd} needs --target <name|id>`);
  const target = pick(await api('GET', '/api/qa/targets'), a.target, 'target');
  const body = { targetId: target.id, kind: cmd };
  if (cmd === 'run' && a.test.length) {
    const tests = await api('GET', `/api/qa/tests?targetId=${encodeURIComponent(target.id)}`);
    body.testIds = a.test.map((t) => pick(tests, t, 'test').id);
  }
  if (cmd === 'explore' && a.goal) body.goal = a.goal;
  const started = await api('POST', '/api/qa/runs', body);
  console.log(`started ${cmd} ${started.id} on ${target.name}`);
  const run = await waitFor(started.id, Number(a.minutes) || Math.max(10, (target.budgets?.minutes ?? 15) * 2));
  print(run);
  if (run.status === 'passed') return 0;
  if (run.status === 'passed_with_repair') return a.strict ? 1 : 0;
  return 1;
}

main().then((code) => process.exit(code), (err) => { console.error(`qa: ${err.message}`); process.exit(2); });

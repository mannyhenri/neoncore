/**
 * THE RUN REPORT — one static HTML page per run (scope §4, "Report"): results, the evidence
 * (screenshots, console errors, failed requests, the trace), repairs to review and findings.
 *
 * Everything shown is escaped: it comes from the app under test, which can say anything.
 * Evidence files are served only from inside the run's own directory (evidenceFile).
 */
import fs from 'fs';
import path from 'path';
import { listFindings } from './findings.js';
import { runDir } from './runner.js';
import { getRun, getTarget, getTest, listRepairs, resultsOf } from './store.js';
import { QaError, type RunnerResult } from './types.js';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** A file of a run's evidence, or a QaError: never anything outside that run's directory. */
export function evidenceFile(runId: string, file: string): string {
  if (!/^[0-9a-f-]{8,}$/i.test(runId)) throw new QaError('bad run id', 400);
  const root = path.resolve(runDir(runId));
  const abs = path.resolve(root, file);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new QaError('that file is not part of this run', 403);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new QaError('no such evidence', 404);
  return abs;
}

/** An evidence path as the runner wrote it (absolute) → a link served from this run. */
export function evidenceUrl(runId: string, p: string | undefined): string {
  if (!p) return '';
  const rel = path.isAbsolute(p) ? path.relative(runDir(runId), p) : p;
  if (rel.startsWith('..')) return '';
  return `/api/qa/evidence/${runId}/${rel.split(path.sep).map(encodeURIComponent).join('/')}`;
}

export function runReportHtml(runId: string): string {
  const run = getRun(runId);
  if (!run) throw new QaError('run not found', 404);
  const target = getTarget(run.targetId);
  const results = resultsOf(runId);
  const repairs = listRepairs({ runId });
  const findings = listFindings(run.targetId).filter((f) => f.runId === runId);
  const rows = results.map((r) => {
    const t = getTest(r.testId);
    const ev = r.evidence as Partial<RunnerResult>;
    const shots = (ev.steps ?? []).filter((s) => s.screenshot).map((s) => `<a href="${esc(evidenceUrl(runId, s.screenshot))}"><img src="${esc(evidenceUrl(runId, s.screenshot))}" alt="step ${s.index + 1}"></a>`).join('');
    const steps = (t?.sentences ?? []).map((s, i) => {
      const st = (ev.steps ?? []).find((x) => x.index === i);
      return `<li class="${esc(st?.status ?? 'skipped')}">${esc(s)}${st?.error ? `<div class="err">${esc(st.error)}</div>` : ''}</li>`;
    }).join('');
    const consoleErr = (ev.console ?? []).length ? `<details><summary>Console (${ev.console!.length})</summary><pre>${esc(ev.console!.join('\n'))}</pre></details>` : '';
    const net = (ev.network ?? []).filter((n) => n.status >= 400 || n.status === 0);
    const network = net.length ? `<details><summary>Failed requests (${net.length})</summary><pre>${esc(net.map((n) => `${n.method} ${n.url} → ${n.status}`).join('\n'))}</pre></details>` : '';
    const trace = ev.trace ? `<a href="${esc(evidenceUrl(runId, ev.trace))}">trace</a>` : '';
    return `<section class="result ${esc(r.status)}"><h3>${esc(t?.name ?? r.testId)} <span class="tag">${esc(r.status.replace(/_/g, ' '))}</span></h3>
      ${r.error ? `<p class="err">${esc(r.error)}</p>` : ''}<ol>${steps}</ol>${shots ? `<div class="shots">${shots}</div>` : ''}${consoleErr}${network}${trace}</section>`;
  }).join('\n');
  const repairRows = repairs.map((p) => `<section class="repair"><h3>Repair · ${esc(getTest(p.testId)?.name ?? p.testId)} · sentence ${p.sentenceIndex + 1} <span class="tag">${esc(p.status)}</span></h3>
      <p>${esc(p.sentence)}</p><div class="diff"><pre>${esc(JSON.stringify(p.before, null, 2))}</pre><pre>${esc(JSON.stringify(p.after, null, 2))}</pre></div></section>`).join('\n');
  const findingRows = findings.map((f) => `<section class="finding ${esc(f.severity)}"><h3>${esc(f.title)} <span class="tag">${esc(f.severity)}</span> <span class="tag">seen ${f.seenCount}×</span></h3>
      <p>${esc(f.page)} — ${esc(f.detail)}</p><ol>${f.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
      ${f.screenshot ? `<img src="${esc(evidenceUrl(runId, f.screenshot))}" alt="">` : ''}</section>`).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QA run ${esc(run.id.slice(0, 8))}</title>
<style>
:root{--bg:#04060C;--panel:#0b1120;--ink:#e6ecf7;--dim:#8fa0bd;--ok:#2fd39a;--warn:#f5a524;--bad:#ff5b5b;--line:#1c2742}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--ink);font:14px/1.5 ui-sans-serif,system-ui,sans-serif}
main{max-width:980px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;color:var(--dim);margin:28px 0 8px;text-transform:uppercase;letter-spacing:.08em}
section{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:10px 0}h3{font-size:14px;margin:0 0 6px}
.tag{font:11px ui-monospace,monospace;border:1px solid var(--line);border-radius:6px;padding:1px 6px;color:var(--dim);margin-left:6px}
li.passed{color:var(--ok)}li.failed{color:var(--bad)}li.skipped{color:var(--dim)}.err{color:var(--bad);font-family:ui-monospace,monospace;font-size:12px}
.result.passed h3 .tag{color:var(--ok)}.result.failed h3 .tag{color:var(--bad)}.result.passed_with_repair h3 .tag{color:var(--warn)}
img{max-width:100%;border:1px solid var(--line);border-radius:6px;margin:6px 6px 0 0}.shots img{max-width:300px}
pre{white-space:pre-wrap;word-break:break-word;background:#060a14;padding:8px;border-radius:6px;font-size:12px}.diff{display:grid;grid-template-columns:1fr 1fr;gap:8px}
@media (max-width:640px){.diff{grid-template-columns:1fr}}a{color:#7cc4ff}
</style></head><body><main>
<h1>QA ${esc(run.kind)} · ${esc(target?.name ?? run.targetId)}</h1>
<p>${esc(run.status.replace(/_/g, ' '))} · ${esc(run.summary)} · ${run.aiCalls} AI call${run.aiCalls === 1 ? '' : 's'} · started ${esc(run.createdAt)}${run.finishedAt ? ` · finished ${esc(run.finishedAt)}` : ''}</p>
${run.error ? `<p class="err">${esc(run.error)}</p>` : ''}
${results.length ? `<h2>Tests</h2>${rows}` : ''}
${repairs.length ? `<h2>Repairs to review</h2>${repairRows}` : ''}
${findings.length ? `<h2>Findings</h2>${findingRows}` : ''}
</main></body></html>`;
}

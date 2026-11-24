import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { EpicQaRun, EpicQaRunSummary } from '../../types';
import { epicQaChip } from '../EpicQaControls';
import { CARD } from './ui';

/**
 * EPIC QA, PER PROJECT — for every project, whether or not it has a web UI.
 *
 * When an epic finishes, the server re-runs every feature's locked acceptance tests and the
 * project's QA command (server lib/qa/epic-acceptance.ts). This lists each finished epic's run,
 * and — opened — each check: what it was, its command, pass or fail, and its output, so a failure
 * says what to fix. Browser QA (targets) is the rest of this page; this needs none.
 */

interface Row { projectId: string; projectName: string; epicId: string; epicName: string; qa: string; run: EpicQaRunSummary | null }

const KIND_LABEL: Record<string, string> = {
  test: 'Locked test', command: 'Command criterion', 'qa-command': 'QA command', tamper: 'Tamper check', checklist: 'Checklist (confirmed at review)',
};

export function EpicQaSection() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [run, setRun] = useState<EpicQaRun | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const projects = await api.getGoalProjects();
        const charts = await Promise.all(projects.map((p) => api.getRoadmap(p.id).then((c) => ({ p, c })).catch(() => null)));
        const out: Row[] = [];
        for (const x of charts) {
          if (!x) continue;
          for (const e of x.c.epics) {
            if (e.qa !== 'waiting' && e.qa !== 'passed' && !e.qaRun) continue;
            out.push({ projectId: x.p.id, projectName: x.p.name, epicId: e.id, epicName: e.name, qa: e.qa ?? 'none', run: e.qaRun ?? null });
          }
        }
        if (live) setRows(out);
      } catch (e) {
        if (live) setErr(e instanceof Error ? e.message : 'Could not load epic QA.');
      }
    })();
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!open) { setRun(null); return; }
    let live = true;
    api.getEpicQa(open).then((r) => { if (live) setRun(r.run); }).catch(() => { if (live) setRun(null); });
    return () => { live = false; };
  }, [open]);

  if (err) return <p className="text-[13px] text-red-300">{err}</p>;
  if (!rows) return null;
  if (rows.length === 0) return null;

  const byProject = new Map<string, Row[]>();
  for (const r of rows) byProject.set(r.projectName, [...(byProject.get(r.projectName) ?? []), r]);

  return (
    <section data-epic-qa-section className={`${CARD} space-y-3`}>
      <div>
        <h3 className="font-display text-lg font-semibold text-gray-100">Epic QA</h3>
        <p className="text-[13px] text-gray-400">When an epic finishes, every feature's locked tests and the project's QA command run together. A failed run blocks Passed QA.</p>
      </div>
      {[...byProject.entries()].map(([name, list]) => (
        <div key={name} className="space-y-1.5">
          <div className="text-[12px] uppercase tracking-[0.12em] text-gray-500">{name}</div>
          {list.map((r) => {
            const chip = r.qa === 'passed' && !r.run ? { text: 'Passed QA', cls: 'bg-emerald-500/12 text-emerald-200' } : epicQaChip(r.run);
            const isOpen = open === r.epicId;
            return (
              <div key={r.epicId} className="rounded-xl border border-white/[0.08] bg-white/[0.02]">
                <div className="flex items-center gap-2 px-3 py-2 flex-wrap">
                  <span className="text-[14px] text-gray-100 font-semibold truncate">{r.epicName}</span>
                  <span className={`px-2 h-6 inline-flex items-center rounded-full text-[12px] font-semibold ${chip.cls}`}>{chip.text}</span>
                  <span className="flex-1" />
                  {r.run && (
                    <button type="button" onClick={() => setOpen(isOpen ? null : r.epicId)} aria-expanded={isOpen}
                      aria-label={`Checks · ${r.epicName}`}
                      className="h-8 px-2.5 rounded-lg text-[12px] font-semibold text-neon-300 hover:bg-white/5">
                      {isOpen ? 'Hide checks' : 'Checks'}
                    </button>
                  )}
                </div>
                {isOpen && run && (
                  <ul className="border-t border-white/[0.06] divide-y divide-white/[0.05]">
                    {run.error && <li className="px-3 py-2 text-[12px] text-red-300">{run.error}</li>}
                    {run.checks.map((c, i) => (
                      <li key={i} data-testid={`epic-qa-check-${c.criterionId || `${c.kind}-${i}`}`} className="px-3 py-2 space-y-1">
                        <div className="flex items-center gap-2 flex-wrap text-[12px]">
                          <span className={`px-1.5 py-0.5 rounded font-semibold ${c.passed ? 'bg-emerald-500/12 text-emerald-200' : 'bg-red-500/15 text-red-200'}`}>
                            {c.passed ? 'pass' : c.timedOut ? 'fail · timed out' : 'fail'}
                          </span>
                          <span className="text-gray-400">{KIND_LABEL[c.kind] ?? c.kind}</span>
                          <span className="text-gray-200">{c.feature}{c.criterionId ? ` · ${c.criterionId}` : ''}</span>
                        </div>
                        {c.text && <p className="text-[12px] text-gray-400">{c.text}</p>}
                        {c.command && <code className="block text-[12px] font-mono text-neon-200 break-all">{c.command}</code>}
                        {c.output && (
                          <pre className="max-h-[180px] overflow-auto rounded-lg bg-gl-code border border-white/[0.06] p-2 text-[11px] leading-snug font-mono text-gray-300 whitespace-pre-wrap">{c.output}</pre>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </section>
  );
}

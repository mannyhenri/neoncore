/**
 * THE PROJECTS BRIDGE — the Projects screen as a ship's operations deck.
 *
 * Nothing about what the screen DOES changes: the project list and the workspace are the same
 * components as before (components/ProjectsPage.tsx), untouched. This file adds what stands
 * around them — the captain over the list, the gauges under the workspace — and index.css
 * (".bridge") gives the controls inside their console look.
 *
 * Art rule (docs/DESIGN.md): the captain and the deck are drawn art built by
 * scripts/world/build_bridge.py. There is no figure drawn from code: without the art the
 * captain is simply absent.
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { parseProjectHash } from '../../lib/projectSelection';
import { BRIDGE } from './art';
import { BRIEF_MS, CELEBRATE_MS, CAPTAIN_FPS, captainAnim, formatSpent, gaugesFor, needsYou } from './captainState';
import { deadlineFor } from '../milestones';
import type { DatedFeature } from '../milestones';
import type { BridgeProject } from './captainState';

/** The projects (polled like the rest of the dashboard) and which one the address names. */
function useBridge(): { projects: BridgeProject[]; goals: DatedFeature[]; selectedId: string | null } {
  const [projects, setProjects] = useState<BridgeProject[]>([]);
  const [goals, setGoals] = useState<DatedFeature[]>([]);
  const [asked, setAsked] = useState<string | null>(() => parseProjectHash(window.location.hash)?.projectId ?? null);
  useEffect(() => {
    let alive = true;
    const load = () => {
      api.getGoalProjects().then((p) => { if (alive && Array.isArray(p)) setProjects(p); }).catch(() => {});
      api.getGoals().then((g) => { if (alive && Array.isArray(g)) setGoals(g); }).catch(() => {});
    };
    load();
    const t = setInterval(load, 15_000);
    const onHash = () => setAsked(parseProjectHash(window.location.hash)?.projectId ?? null);
    window.addEventListener('hashchange', onHash);
    return () => { alive = false; clearInterval(t); window.removeEventListener('hashchange', onHash); };
  }, []);
  // The same never-blank rule as the workspace (lib/projectSelection.ts): the project the
  // address names, else the first one — so the gauges and the captain read what is on screen.
  const selectedId = asked && projects.some((p) => p.id === asked) ? asked : projects[0]?.id ?? null;
  return { projects, goals, selectedId };
}

/** The captain, above the project list. His cycle is his state (captainState.ts). */
export function BridgeCaptain({ height = 190 }: { height?: number }) {
  const { projects, goals, selectedId } = useBridge();
  // "Just selected" starts on a CHANGE of selection, never on opening the screen.
  const [seen, setSeen] = useState(selectedId);
  const [briefing, setBriefing] = useState(false);
  if (seen !== selectedId) { setSeen(selectedId); setBriefing(seen !== null && selectedId !== null); }
  useEffect(() => {
    if (!briefing) return;
    const t = setTimeout(() => setBriefing(false), BRIEF_MS);
    return () => clearTimeout(t);
  }, [briefing, selectedId]);

  // "Just delivered": the SAME project has one more feature delivered than at the last look.
  const selectedNow = projects.find((p) => p.id === selectedId);
  const doneNow = selectedNow?.featuresDone ?? 0;
  const [doneSeen, setDoneSeen] = useState<{ id: string | null; done: number } | null>(null);
  const [celebrating, setCelebrating] = useState(false);
  if (selectedNow && (doneSeen === null || doneSeen.id !== selectedId || doneSeen.done !== doneNow)) {
    setCelebrating(doneSeen !== null && doneSeen.id === selectedId && doneNow > doneSeen.done);
    setDoneSeen({ id: selectedId, done: doneNow });
  }
  useEffect(() => {
    if (!celebrating) return;
    const t = setTimeout(() => setCelebrating(false), CELEBRATE_MS);
    return () => clearTimeout(t);
  }, [celebrating, doneNow]);

  const deadline = selectedId ? deadlineFor(goals, selectedId, Date.now()) : null;
  const anim = captainAnim({
    needsYou: needsYou(projects, selectedId), justDelivered: celebrating, justSelected: briefing,
    deadline: deadline?.state ?? null, underWay: (selectedNow?.featuresActive ?? 0) > 0,
  });
  const sheet = BRIDGE.captain;
  const selected = projects.find((p) => p.id === selectedId);
  const name = selected?.name ?? 'A project';
  const line = {
    call: `${name} needs you`,
    celebrate: `${name}: feature delivered`,
    brief: `${name} on the board`,
    worry: deadline && deadline.daysLeft < 0 ? `${name}: ${-deadline.daysLeft}d past its date` : `${name}: ${deadline?.daysLeft ?? 0}d to its date`,
    log: `${name}: work under way`,
    idle: 'Standing by',
  }[anim];

  return (
    <div className="bridge-captain" data-captain-state={anim} data-alert={anim === 'worry' || undefined}>
      {sheet && (() => {
        const { row, frames } = sheet.rows[anim];
        const width = (height * sheet.frameW) / sheet.frameH;
        const cols = Math.max(...Object.values(sheet.rows).map((r) => r.frames));
        const rows = Object.keys(sheet.rows).length;
        return (
          <div data-bridge-captain aria-hidden="true" className="overflow-hidden mx-auto" style={{ width, height }}>
            <div
              key={anim}
              className="world-strip"
              style={{
                width: width * frames,
                height,
                backgroundImage: `url(${sheet.src})`,
                backgroundRepeat: 'no-repeat',
                backgroundSize: `${width * cols}px ${height * rows}px`,
                backgroundPosition: `0 ${-row * height}px`,
                animationDuration: `${frames / CAPTAIN_FPS[anim]}s`,
                animationTimingFunction: `steps(${frames})`,
              }}
            />
          </div>
        );
      })()}
      <div className="bridge-readout" role="status">{line}</div>
    </div>
  );
}

/** The strip of gauges under the workspace: repos, spent, features — for what is selected. */
export function BridgeGauges() {
  const { projects, selectedId } = useBridge();
  const g = gaugesFor(projects, selectedId);
  const cells: { key: string; label: string; value: string; fill: number }[] = [
    { key: 'repos', label: 'Repos', value: String(g.repos), fill: Math.min(1, g.repos / 8) },
    { key: 'spent', label: 'Spent', value: formatSpent(g.spentUsd), fill: Math.min(1, g.spentUsd / 50_000) },
    { key: 'features', label: 'Features', value: g.features === 0 ? '0' : `${g.done}/${g.features}`, fill: g.features === 0 ? 0 : g.done / g.features },
  ];
  return (
    <div className="bridge-gauges" aria-label={`Readings · ${g.scope}`}>
      {cells.map((c) => (
        <div key={c.key} data-gauge={c.key} className="bridge-gauge">
          <div className="min-w-0">
            <div className="bridge-gauge-label">{c.label}</div>
            <div className="bridge-gauge-value" data-gauge-value>{c.value}</div>
          </div>
          <div className="bridge-bars" aria-hidden="true">
            {Array.from({ length: 8 }, (_, i) => <span key={i} data-on={i < Math.round(c.fill * 8) || undefined} style={{ height: `${30 + i * 10}%` }} />)}
          </div>
        </div>
      ))}
    </div>
  );
}

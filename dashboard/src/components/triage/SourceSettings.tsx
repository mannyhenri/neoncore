/**
 * A SOURCE: a Jira site, its projects, where their code lives, and the guardrails for its bugs.
 * The Jira login is the NAMES of environment variables (JIRA_EMAIL, JIRA_API_TOKEN), never the
 * values — there is no field here that takes a token, and nothing a log or comment shows can
 * contain one. The agent only comments and labels unless status changes are switched on.
 */
import { useState } from 'react';
import type { Agent } from '../../types';
import type { TriageSource } from './types';
import { DEFAULT_LIMITS, DEFAULT_PROTECTED_PATHS, webhookUrl } from '../../lib/triageApi';
import { BTN_GHOST, BTN_PRIMARY, CARD, INPUT } from './ui';

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const PROJECT_KEY = /^[A-Z][A-Z0-9_]*$/;

export function blankSource(): Omit<TriageSource, 'id'> {
  return {
    name: '', jiraBaseUrl: '', authEnv: { email: 'JIRA_EMAIL', token: 'JIRA_API_TOKEN' },
    projects: [], issueTypes: ['Bug'], repoFor: {}, reporters: 'internal', transitions: false,
    protectedPaths: [...DEFAULT_PROTECTED_PATHS], limits: { ...DEFAULT_LIMITS }, pollSeconds: 60,
    webhookSecretEnv: '', triageAgentId: '', codeAgentType: 'claude',
  };
}

const splitList = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
const isUrl = (u: string) => { try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:'; } catch { return false; } };

const LIMIT_FIELDS: { key: keyof TriageSource['limits']; label: string; hint?: string }[] = [
  { key: 'maxFiles', label: 'Max files per fix', hint: 'A bigger fix is handed to a person.' },
  { key: 'maxLines', label: 'Max lines changed' },
  { key: 'minutesPerIssue', label: 'Minutes per issue' },
  { key: 'dispatchesPerIssue', label: 'Agent requests per issue' },
  { key: 'reviewRounds', label: 'Review rounds', hint: 'Follow-up commits after "changes requested".' },
];

export function SourceSettings({ initial, agents, origin, onSave, onCancel }: {
  initial: TriageSource | Omit<TriageSource, 'id'>;
  agents: Agent[];
  origin: string;
  onSave: (s: Omit<TriageSource, 'id'> & { id?: string }) => Promise<void> | void;
  onCancel?: () => void;
}) {
  const [s, setS] = useState(initial);
  const [projects, setProjects] = useState(initial.projects.join(', '));
  const [types, setTypes] = useState(initial.issueTypes.join(', '));
  const [paths, setPaths] = useState(initial.protectedPaths.join('\n'));
  const [repos, setRepos] = useState<{ key: string; repo: string }[]>(
    Object.entries(initial.repoFor).map(([key, repo]) => ({ key, repo })),
  );
  const [copied, setCopied] = useState(false);
  const id = 'id' in initial ? initial.id : '';

  const envNames = [s.authEnv.email, s.authEnv.token, ...(s.webhookSecretEnv ? [s.webhookSecretEnv] : [])];
  const badEnv = envNames.some((n) => !ENV_NAME.test(n));
  const projectList = splitList(projects).map((p) => p.toUpperCase());
  const badProject = projectList.some((p) => !PROJECT_KEY.test(p));
  const valid = s.name.trim() && isUrl(s.jiraBaseUrl) && !badEnv && !badProject && projectList.length > 0;

  const save = () => {
    const repoFor: Record<string, string> = {};
    for (const r of repos) if (r.key.trim() && r.repo.trim()) repoFor[r.key.trim().toUpperCase()] = r.repo.trim();
    return onSave({
      ...s, name: s.name.trim(), jiraBaseUrl: s.jiraBaseUrl.trim().replace(/\/+$/, ''),
      projects: projectList, issueTypes: splitList(types).length ? splitList(types) : ['Bug'],
      protectedPaths: splitList(paths), repoFor,
    });
  };

  const field = (label: string, el: React.ReactNode, hint?: string) => (
    <label className="block space-y-1">
      <span className="text-[12px] text-gray-400">{label}</span>
      {el}
      {hint && <span className="block text-[11px] text-gray-500">{hint}</span>}
    </label>
  );
  const envInput = (label: string, value: string, set: (v: string) => void, placeholder: string) => (
    <input className={`${INPUT} font-mono`} value={value} placeholder={placeholder} aria-label={label} data-env-name
      onChange={(e) => set(e.target.value.toUpperCase())} />
  );

  return (
    <div data-triage-source-form className={`${CARD} space-y-5`}>
      <div className="grid md:grid-cols-2 gap-3">
        {field('Name', <input className={INPUT} value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} placeholder="Demo Jira" />)}
        {field('Jira site', <input className={INPUT} value={s.jiraBaseUrl} onChange={(e) => setS({ ...s, jiraBaseUrl: e.target.value })} placeholder="https://your-team.atlassian.net" />,
          'Locally NeonCore polls Jira; Jira Cloud cannot reach this machine.')}
        {field('Service account email — variable name', envInput('Email variable name', s.authEnv.email, (v) => setS({ ...s, authEnv: { ...s.authEnv, email: v } }), 'JIRA_EMAIL'))}
        {field('API token — variable name', envInput('Token variable name', s.authEnv.token, (v) => setS({ ...s, authEnv: { ...s.authEnv, token: v } }), 'JIRA_API_TOKEN'),
          'The NAME of the environment variable that holds it. The token itself never goes in here.')}
        {field('Projects', <input className={INPUT} value={projects} onChange={(e) => setProjects(e.target.value)} placeholder="DEMO, APP" />, 'Jira project keys.')}
        {field('Issue types', <input className={INPUT} value={types} onChange={(e) => setTypes(e.target.value)} placeholder="Bug" />)}
      </div>
      {(badEnv || badProject) && (
        <div className="text-[12px] text-red-200">
          {badEnv && 'A variable name is capital letters, digits and underscores, e.g. JIRA_API_TOKEN. '}
          {badProject && 'A project key is capital letters and digits, e.g. DEMO.'}
        </div>
      )}

      <div className="space-y-2">
        <div className="text-[12px] text-gray-400">Where each project's code lives — the agent fixes bugs there, on its own branch per issue.</div>
        {repos.map((r, i) => (
          <div key={i} data-triage-repo-map className="grid grid-cols-[140px_1fr_auto] gap-2">
            <input className={`${INPUT} font-mono`} value={r.key} placeholder="DEMO" aria-label="Project key"
              onChange={(e) => setRepos(repos.map((x, j) => (j === i ? { ...x, key: e.target.value.toUpperCase() } : x)))} />
            <input className={`${INPUT} font-mono`} value={r.repo} placeholder="/Users/you/code/demo-app" aria-label="Repository path"
              onChange={(e) => setRepos(repos.map((x, j) => (j === i ? { ...x, repo: e.target.value } : x)))} />
            <button className={BTN_GHOST} aria-label="Remove repository" onClick={() => setRepos(repos.filter((_, j) => j !== i))}>×</button>
          </div>
        ))}
        <button className={BTN_GHOST} onClick={() => setRepos([...repos, { key: projectList[repos.length] ?? '', repo: '' }])}>+ Map a project to a repository</button>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-[12px] text-gray-400">Who files the bugs</legend>
        {(['internal', 'external'] as const).map((r) => (
          <label key={r} className="flex items-start gap-2 text-[13px] text-gray-300">
            <input type="radio" name="reporters" checked={s.reporters === r} onChange={() => setS({ ...s, reporters: r })} className="mt-1" />
            <span>
              {r === 'internal' ? <b>Staff</b> : <b>External customers</b>}
              <span className="block text-[12px] text-gray-500">
                {r === 'internal'
                  ? 'The "solution found" comment goes out as soon as the pull request is opened.'
                  : 'The "solution found" comment is held until a person approves the pull request, so a customer never hears of a fix nobody has reviewed.'}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      <label className="flex items-center gap-2 text-[13px] text-gray-300">
        <input type="checkbox" data-triage-transitions checked={s.transitions} onChange={(e) => setS({ ...s, transitions: e.target.checked })} />
        Let the agent change issue statuses (off: it only comments and labels)
      </label>

      <div className="grid md:grid-cols-2 gap-3">
        {field('Protected paths', <textarea className={`${INPUT} h-28 py-2 font-mono text-[12px]`} value={paths} onChange={(e) => setPaths(e.target.value)} aria-label="Protected paths" />,
          'A fix that touches any of these is never made automatically — the agent hands over with its analysis.')}
        <div className="grid grid-cols-2 gap-3 content-start">
          {LIMIT_FIELDS.map((l) => (
            <div key={l.key}>{field(l.label, (
              <input className={INPUT} type="number" min={1} aria-label={l.label} value={s.limits[l.key]}
                onChange={(e) => setS({ ...s, limits: { ...s.limits, [l.key]: Math.max(1, Number(e.target.value) || 1) } })} />
            ), l.hint)}</div>
          ))}
        </div>
      </div>

      <div className="grid md:grid-cols-3 gap-3">
        {field('Poll every (seconds)', <input className={INPUT} type="number" min={15} aria-label="Poll seconds" value={s.pollSeconds}
          onChange={(e) => setS({ ...s, pollSeconds: Math.max(15, Number(e.target.value) || 60) })} />)}
        {field('Cartridge for triage', (
          <select className={`${INPUT} glass-input`} value={s.triageAgentId} onChange={(e) => setS({ ...s, triageAgentId: e.target.value })} aria-label="Triage cartridge">
            <option value="">Pick a cartridge…</option>
            {agents.filter((a) => a.status !== 'offline').map((a) => <option key={a.id} value={a.id}>{a.repoName || a.name}</option>)}
          </select>
        ), 'Reads reports, finds duplicates, classifies. Changes no code.')}
        {field('Engine for code work', (
          <select className={`${INPUT} glass-input`} value={s.codeAgentType} onChange={(e) => setS({ ...s, codeAgentType: e.target.value })} aria-label="Code engine">
            <option value="claude">Claude Code</option>
            <option value="codex">Codex</option>
          </select>
        ), 'Launched per issue in its own worktree, on branch bug/<KEY>.')}
      </div>

      <div className="space-y-2">
        {field('Webhook secret — variable name (optional)', envInput('Webhook secret variable name', s.webhookSecretEnv, (v) => setS({ ...s, webhookSecretEnv: v }), 'JIRA_WEBHOOK_SECRET'),
          'For a public deployment Jira can post here instead of being polled; each call is checked against this secret.')}
        {id && (
          <div data-triage-webhook className="flex items-center gap-2">
            <code className="flex-1 truncate rounded-[10px] bg-gl-code border border-white/[0.08] px-3 py-2 font-mono text-[12px] text-gray-200">{webhookUrl(origin, id)}</code>
            <button className={BTN_GHOST} onClick={() => { void navigator.clipboard?.writeText(webhookUrl(origin, id)).then(() => setCopied(true)).catch(() => {}); }}>{copied ? 'Copied' : 'Copy'}</button>
          </div>
        )}
      </div>

      <div className="flex gap-2 justify-end">
        {onCancel && <button className={BTN_GHOST} onClick={onCancel}>Cancel</button>}
        <button className={BTN_PRIMARY} disabled={!valid} onClick={save}>Save source</button>
      </div>
    </div>
  );
}

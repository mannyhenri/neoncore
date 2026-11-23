/**
 * A TARGET: the app under test and its guardrails. Logins are the NAMES of environment variables
 * (QA_SUPERVISOR_USER), never the values — there is no field here that takes a password, and
 * nothing a report or log shows can contain one. Production stays off unless switched on.
 */
import { useState } from 'react';
import type { Agent } from '../../types';
import type { QaCredentialEnv, QaTarget } from './types';
import { BTN_GHOST, BTN_PRIMARY, CARD, INPUT } from './ui';

export const DEFAULT_DENY = ['delete', 'remove', 'pay', 'purchase', 'send email', 'unsubscribe'];
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

export function blankTarget(): Omit<QaTarget, 'id'> {
  return {
    projectId: '', name: '', baseUrl: '', allowHosts: [], denyActions: [...DEFAULT_DENY],
    credentialsEnv: {}, productionAllowed: false, budgets: { steps: 60, minutes: 15 }, agentId: '',
  };
}

const splitList = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
const hostOf = (url: string) => { try { return new URL(url).host; } catch { return ''; } };

export function TargetSettings({ initial, agents, onSave, onCancel }: {
  initial: QaTarget | Omit<QaTarget, 'id'>;
  agents: Agent[];
  onSave: (t: Omit<QaTarget, 'id'> & { id?: string }) => Promise<void> | void;
  onCancel?: () => void;
}) {
  const [t, setT] = useState(initial);
  const [hosts, setHosts] = useState(initial.allowHosts.join(', '));
  const [deny, setDeny] = useState(initial.denyActions.join(', '));
  const [creds, setCreds] = useState<{ role: string; user: string; pass: string }[]>(
    Object.entries(initial.credentialsEnv).map(([role, c]) => ({ role, ...c })),
  );
  const badEnv = creds.some((c) => (c.user && !ENV_NAME.test(c.user)) || (c.pass && !ENV_NAME.test(c.pass)));
  const valid = t.name.trim() && hostOf(t.baseUrl) && !badEnv;

  const save = () => {
    const allowHosts = splitList(hosts);
    const baseHost = hostOf(t.baseUrl);
    // The base URL's own host is always allowed: a target that cannot open itself is no target.
    if (baseHost && !allowHosts.includes(baseHost)) allowHosts.unshift(baseHost);
    const credentialsEnv: Record<string, QaCredentialEnv> = {};
    for (const c of creds) if (c.role.trim() && c.user && c.pass) credentialsEnv[c.role.trim()] = { user: c.user, pass: c.pass };
    return onSave({ ...t, name: t.name.trim(), allowHosts, denyActions: splitList(deny), credentialsEnv });
  };

  const field = (label: string, el: React.ReactNode, hint?: string) => (
    <label className="block space-y-1">
      <span className="text-[12px] text-gray-400">{label}</span>
      {el}
      {hint && <span className="block text-[11px] text-gray-500">{hint}</span>}
    </label>
  );

  return (
    <div data-qa-target-form className={`${CARD} space-y-4`}>
      <div className="grid md:grid-cols-2 gap-3">
        {field('Name', <input className={INPUT} value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} placeholder="Demo app" />)}
        {field('Base URL', <input className={INPUT} value={t.baseUrl} onChange={(e) => setT({ ...t, baseUrl: e.target.value })} placeholder="http://localhost:4061" />)}
        {field('Allowed hosts', <input className={INPUT} value={hosts} onChange={(e) => setHosts(e.target.value)} placeholder="localhost:4061, staging.example.com" />, 'The browser never opens anything else. The base URL\'s host is always included.')}
        {field('Never do (deny-list)', <input className={INPUT} value={deny} onChange={(e) => setDeny(e.target.value)} />, 'Buttons whose name matches are refused unless a run explicitly allows destructive actions.')}
        {field('Cartridge that does the AI work', (
          <select className={`${INPUT} glass-input`} value={t.agentId} onChange={(e) => setT({ ...t, agentId: e.target.value })} aria-label="Cartridge">
            <option value="">Pick a cartridge…</option>
            {agents.filter((a) => a.status !== 'offline').map((a) => <option key={a.id} value={a.id}>{a.repoName || a.name}</option>)}
          </select>
        ), 'Writes a test\'s actions the first time, repairs failed steps, explores. Cached runs need no cartridge.')}
        <div className="grid grid-cols-2 gap-3">
          {field('Step budget', <input className={INPUT} type="number" min={1} value={t.budgets.steps} onChange={(e) => setT({ ...t, budgets: { ...t.budgets, steps: Math.max(1, Number(e.target.value) || 1) } })} aria-label="Step budget" />)}
          {field('Minutes per run', <input className={INPUT} type="number" min={1} value={t.budgets.minutes} onChange={(e) => setT({ ...t, budgets: { ...t.budgets, minutes: Math.max(1, Number(e.target.value) || 1) } })} aria-label="Minutes per run" />)}
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-[12px] text-gray-400">Test logins — the <b>names</b> of the environment variables that hold them. Values never go in here, in reports or in logs.</div>
        {creds.map((c, i) => (
          <div key={i} data-qa-credential className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2">
            <input className={INPUT} value={c.role} placeholder="Role, e.g. supervisor" aria-label="Role" onChange={(e) => setCreds(creds.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))} />
            <input className={`${INPUT} font-mono`} value={c.user} placeholder="QA_SUPERVISOR_USER" aria-label="User variable name" data-env-name onChange={(e) => setCreds(creds.map((x, j) => (j === i ? { ...x, user: e.target.value.toUpperCase() } : x)))} />
            <input className={`${INPUT} font-mono`} value={c.pass} placeholder="QA_SUPERVISOR_PASS" aria-label="Password variable name" data-env-name onChange={(e) => setCreds(creds.map((x, j) => (j === i ? { ...x, pass: e.target.value.toUpperCase() } : x)))} />
            <button className={BTN_GHOST} aria-label="Remove login" onClick={() => setCreds(creds.filter((_, j) => j !== i))}>×</button>
          </div>
        ))}
        {badEnv && <div className="text-[12px] text-red-200">A variable name is letters, digits and underscores, e.g. QA_SUPERVISOR_PASS.</div>}
        <button className={BTN_GHOST} onClick={() => setCreds([...creds, { role: '', user: '', pass: '' }])}>+ Add a login</button>
      </div>

      <label className="flex items-center gap-2 text-[13px] text-gray-300">
        <input type="checkbox" checked={t.productionAllowed} onChange={(e) => setT({ ...t, productionAllowed: e.target.checked })} />
        Allow production (off by default — runs only against the allowed hosts above)
      </label>

      <div className="flex gap-2 justify-end">
        {onCancel && <button className={BTN_GHOST} onClick={onCancel}>Cancel</button>}
        <button className={BTN_PRIMARY} disabled={!valid} onClick={save}>Save target</button>
      </div>
    </div>
  );
}

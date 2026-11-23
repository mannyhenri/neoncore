/**
 * ONE REQUEST IN FLIGHT PER CARTRIDGE — for every engine that hands requests to cartridges.
 *
 * A cartridge's status turns `working` only when its hooks fire, AFTER a prompt lands. The QA and
 * Triage dispatchers checked only that status, so one sweep (or several issues/runs starting at
 * once) pasted every request into the same idle cartridge back to back: the 11 seeded triage
 * issues would have typed 11 prompts into one terminal. A delivered, unanswered request now holds
 * its cartridge; the next goes once it is answered.
 *
 * SET-BASED: iterates the dispatchers.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import db from '../src/db.ts';
import { installStubIO } from './helpers/stub-io.ts';
import * as qa from '../src/lib/qa/dispatch.ts';
import * as triage from '../src/lib/triage/dispatch.ts';

installStubIO();

function cartridge(): string {
  const id = randomUUID();
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, status, last_seen, agent_type) VALUES (?, ?, 'box', ?, 'r', 'idle', ?, 'claude')`)
    .run(id, `box/${id.slice(0, 6)}`, `/tmp/${id}`, new Date().toISOString());
  return id;
}

interface Dispatcher {
  name: string;
  setSender(fn: (agentId: string, prompt: string) => { ok: true }): void;
  /** Make n requests for one cartridge; their ids. */
  make(agentId: string, n: number): string[];
  sweep(): void;
  complete(id: string): void;
  delivered(id: string): boolean;
}

const DISPATCHERS: Dispatcher[] = [
  {
    name: 'QA',
    setSender: (fn) => qa.setQaSender(fn),
    make: (agentId, n) => {
      const runId = randomUUID();
      return Array.from({ length: n }, () => qa.dispatchRequest({ runId, kind: 'explore', agentId, prompt: (id) => `qa ${id}` }).id);
    },
    sweep: () => qa.sweepQaRequests(),
    complete: (id) => qa.completeRequest(id, {}),
    delivered: (id) => !!qa.getRequest(id)?.dispatchedAt,
  },
  {
    name: 'Triage',
    setSender: (fn) => triage.setTriageSender(fn),
    make: (agentId, n) => Array.from({ length: n }, () => {
      const issueId = randomUUID();
      db.pragma('foreign_keys = OFF');
      db.prepare(`INSERT INTO triage_issues (id, source_id, origin, issue_key, project_key, stage, state, created_at, updated_at) VALUES (?, 's', 'jira', ?, 'DEMO', 'triage', 'working', ?, ?)`)
        .run(issueId, `DEMO-${Math.floor(Math.random() * 1e6)}`, new Date().toISOString(), new Date().toISOString());
      db.pragma('foreign_keys = ON');
      return triage.dispatchRequest({ issueId, stage: 'triage', agentId, prompt: (id) => `triage ${id}` }).id;
    }),
    sweep: () => triage.sweepTriageRequests(),
    complete: (id) => triage.completeRequest(id, {}),
    delivered: (id) => !!triage.getRequest(id)?.dispatchedAt,
  },
];

for (const d of DISPATCHERS) {
  test(`${d.name}: three requests for one idle cartridge — one is typed in, the next only once it is answered`, () => {
    const sent: string[] = [];
    d.setSender((_agent, prompt) => { sent.push(prompt); return { ok: true }; });
    const agent = cartridge();
    const ids = d.make(agent, 3);
    d.sweep(); d.sweep();
    assert.equal(ids.filter(d.delivered).length, 1, `${d.name}: more than one request was typed into the same cartridge`);
    assert.equal(sent.length, 1);
    const first = ids.find(d.delivered)!;
    d.complete(first);
    d.sweep();
    assert.equal(ids.filter(d.delivered).length, 2, `${d.name}: the next request did not go once the first was answered`);
    assert.equal(sent.length, 2);
  });
}

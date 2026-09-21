import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { conferOptionLabel, workflowAgentOptions } from '../lib/workflow-agent-options';

/**
 * PICKING A CARTRIDGE FOR A CONFER: THE SAME LIST THE APP SHOWS, AND YOU CAN TELL THEM APART.
 *
 * Two complaints, one picker:
 *
 *  1. "we should see also with the repo name (cartridge) if it's claude or codex ... so I can
 *     pick the right instance." One repo can hold a claude cartridge AND a codex one — the
 *     dedupe key already keeps both (`repoPath|agentType`) — but every picker rendered
 *     `{a.repoName || a.name}`, so the two arrived as two identical chips. Indistinguishable,
 *     and picking the wrong one is silent.
 *
 *  2. "the list of items available for confer in the workflow should reflect what I see in the
 *     app, nothing more nothing less." The three pickers read three DIFFERENT sources — raw
 *     `agents`, raw `agents`, and `onlineAgents` — while the app's own selectors go through
 *     `workflowAgentOptions`, which drops dismissed rows, ages out stale ones and collapses
 *     superseded checkouts. So the confer list showed cartridges the app does not.
 *
 * SET-BASED over the surfaces DISCOVERED in the source, the same way confer-launch-gate.test.ts
 * finds them, because "fixed the one I had open" is the exact failure here: there are three,
 * and the confer launch gate had already been reported three times for precisely that reason.
 */
describe('the confer cartridge label names the engine', () => {
  it('distinguishes two cartridges on the same repo', () => {
    const claude = { id: 'a', repoName: 'baseback', name: 'mac/baseback', agentType: 'claude' };
    const codex = { id: 'b', repoName: 'baseback', name: 'mac/baseback', agentType: 'codex' };
    expect(conferOptionLabel(claude)).not.toBe(conferOptionLabel(codex));
    expect(conferOptionLabel(claude)).toContain('baseback');
    expect(conferOptionLabel(claude)).toMatch(/claude/i);
    expect(conferOptionLabel(codex)).toMatch(/codex/i);
  });

  it('still reads well when the engine is unknown', () => {
    // A pre-column row must not render "baseback · undefined".
    const label = conferOptionLabel({ repoName: 'baseback', name: 'mac/baseback' });
    expect(label).toContain('baseback');
    expect(label).not.toMatch(/undefined|null/);
  });

  it('falls back to the agent name when there is no repo name', () => {
    expect(conferOptionLabel({ name: 'mac/loose-agent', agentType: 'codex' }))
      .toContain('loose-agent');
  });
});

describe('the confer list is the app list', () => {
  const root = path.resolve(__dirname, '../..');
  const code = (f: string) => fs.readFileSync(f, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  /** Every component that lets you choose confer participants. */
  function surfaces(): string[] {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '__tests__') walk(p); continue; }
        if (!/\.tsx?$/.test(e.name)) continue;
        if (/setConferAgents\s*\(/.test(code(p))) out.push(p);
      }
    };
    walk(path.join(root, 'src'));
    return out;
  }

  it('finds every confer surface', () => {
    expect(surfaces().length, 'the scan found no confer picker at all').toBeGreaterThanOrEqual(3);
  });

  it('every surface draws from workflowAgentOptions, not a raw agents array', () => {
    const offenders = surfaces().filter((f) => !/workflowAgentOptions\s*\(/.test(code(f)));
    expect(offenders.map((f) => path.relative(root, f)),
      'these confer pickers list cartridges the app itself filters out — dismissed rows, stale '
      + 'checkouts, superseded duplicates').toEqual([]);
  });

  it('every surface labels its chips through the shared helper', () => {
    const offenders = surfaces().filter((f) => !/conferOptionLabel\s*\(/.test(code(f)));
    expect(offenders.map((f) => path.relative(root, f)),
      'these confer pickers render their own label, so a claude and a codex cartridge on the '
      + 'same repo look identical').toEqual([]);
  });
});

describe('workflowAgentOptions keeps both engines on one repo', () => {
  it('does not collapse a claude and a codex cartridge sharing a checkout', () => {
    const now = Date.now();
    const seen = new Date(now).toISOString();
    const rows = [
      { id: 'a', repoName: 'baseback', repoPath: '/r/baseback', agentType: 'claude', status: 'idle', lastSeen: seen },
      { id: 'b', repoName: 'baseback', repoPath: '/r/baseback', agentType: 'codex', status: 'idle', lastSeen: seen },
    ];
    expect(workflowAgentOptions(rows, { now }).map((a) => a.id).sort()).toEqual(['a', 'b']);
  });
});

/**
 * SPLIT OR SHARED must be offered at launch, on every surface that launches a confer.
 *
 * It was hardcoded to `shared` server-side, so the only way to get a worktree each was to edit
 * the run's rows by hand — done twice in one week. Asked for as "the template should give that
 * option, split or shared".
 *
 * The worktree choice is deliberately NOT offered under `collaborate`: the server refuses that
 * combination (both agents on the same thing in separate trees produce two answers), and a
 * control that offers something the server rejects is a trap rather than a choice.
 */
describe('isolation is a launch choice, not a constant', () => {
  const root2 = path.resolve(__dirname, '../..');
  const code2 = (f: string) => fs.readFileSync(f, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  function conferSurfaces(): string[] {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '__tests__') walk(p); continue; }
        if (!/\.tsx?$/.test(e.name)) continue;
        if (/setConferAgents\s*\(/.test(code2(p))) out.push(p);
      }
    };
    walk(path.join(root2, 'src'));
    return out;
  }

  it('every confer surface offers the isolation choice and sends it', () => {
    const found = conferSurfaces();
    expect(found.length).toBeGreaterThanOrEqual(3);
    const noPicker = found.filter((f) => !/onIsolationChange\s*=/.test(code2(f)));
    expect(noPicker.map((f) => path.relative(root2, f)),
      'these surfaces let you pick a confer but not whether it is split or shared').toEqual([]);
    const noSend = found.filter((f) => !/conferIsolation/.test(code2(f)));
    expect(noSend.map((f) => path.relative(root2, f)),
      'these surfaces show the choice but never send it, so it silently does nothing').toEqual([]);
  });
});

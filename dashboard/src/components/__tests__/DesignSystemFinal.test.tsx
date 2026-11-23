/**
 * THE DESIGN SYSTEM, STEP 2 — selecting a direction finalizes it into a system that is shown here;
 * one button puts it in every repo of the project, and each repo's own result is said. Nothing is
 * committed by selecting; nothing of the server's is ever sent back to it.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor, screen } from '@testing-library/react';
import type { DesignExploration, DesignFinalSystem, DesignPublished, DesignRepoResult } from '../../types';

const srv = vi.hoisted(() => ({
  data: null as DesignExploration | null, repos: [] as string[], system: null as DesignFinalSystem | null, published: null as DesignPublished | null,
  saved: [] as Record<string, unknown>[], finalized: 0, publishedCalls: 0, missing: false, noStep2: false, failFinalize: '', failPublish: '',
  results: null as DesignRepoResult[] | null,
}));
vi.mock('../../lib/api', () => {
  const whole = () => ({ ...(srv.data as DesignExploration), system: srv.system, published: srv.published, repos: srv.repos });
  return { api: {
    getDesignSystem: () => (srv.missing ? Promise.reject(new Error('Not Found')) : Promise.resolve(whole())),
    saveDesignSystem: (_id: string, body: DesignExploration) => {
      if (srv.missing) return Promise.reject(new Error('Not Found'));
      srv.saved.push(JSON.parse(JSON.stringify(body)));
      srv.data = { ...body, updatedAt: 'now' };
      return Promise.resolve(whole());
    },
    finalizeDesignSystem: () => {
      srv.finalized++;
      if (srv.noStep2) return Promise.reject(new Error('Not Found'));
      if (srv.failFinalize) return Promise.reject(new Error(srv.failFinalize));
      const sel = srv.data!.selected!;
      const v = srv.data!.rounds.flatMap((r) => r.variations).find((x) => x.id === sel.variationId)!;
      const same = srv.system && srv.system.from.variationId === sel.variationId;
      if (!same) {
        const version = (srv.system?.version ?? 0) + 1;
        srv.system = { version, finalizedAt: '2026-11-21T10:00:00Z', from: sel, name: v.name, spec: {}, html: `<!doctype html><title>${v.name} v${version}</title><h1>${v.name}</h1>`,
          files: ['tokens.json', 'tokens.css', 'components.css', 'index.html', 'DESIGN-SYSTEM.md'].map((f, i) => ({ path: `design-system/${f}`, bytes: 1024 * (i + 1) })) };
      }
      return Promise.resolve(whole());
    },
    publishDesignSystem: () => {
      srv.publishedCalls++;
      if (srv.failPublish) return Promise.reject(new Error(srv.failPublish));
      srv.published = { version: srv.system!.version, at: '2026-11-21T11:00:00Z',
        repos: srv.results ?? srv.repos.map((p) => ({ repoPath: p, status: 'pushed' as const, detail: '', branch: 'main', commit: 'abc1234' })) };
      return Promise.resolve(whole());
    },
  } };
});

import { DesignSystemTab } from '../DesignSystemTab';
import { proposeRound } from '../../lib/design/designer';

const project = { id: 'p1', name: 'Atlas' } as never;
const REPOS = ['/code/atlas-api', '/code/atlas-web', '/code/atlas-docs', '/code/atlas-mobile'];
const round = () => ({ id: 'r1', at: '2026-11-21T09:00:00Z', ...proposeRound({ colors: ['#ff3b30', '#0a84ff', '#111111'], rounds: [], feedback: '', base: null }) });
const mount = () => render(<DesignSystemTab project={project} />);
const ready = () => waitFor(() => expect(document.querySelector('[data-design-system]')).not.toBeNull());
const q = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const final = () => q('[data-final-system]');
const button = () => q<HTMLButtonElement>('[data-publish-button]');
const selectNth = (i: number) => fireEvent.click(document.querySelectorAll<HTMLElement>('section[data-round] > div > [data-variation] [data-select]')[i]);
const systemShown = (version: number) => waitFor(() => expect(final()?.getAttribute('data-version')).toBe(String(version)));
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-repo]')];

beforeEach(() => {
  Object.assign(srv, { data: { inspirations: [], rounds: [round()], selected: null, updatedAt: '' }, repos: [...REPOS], system: null, published: null,
    saved: [], finalized: 0, publishedCalls: 0, missing: false, noStep2: false, failFinalize: '', failPublish: '', results: null });
  window.localStorage.clear();
});
afterEach(() => cleanup());

describe('the design system — step 2', () => {
  it('nothing of step 2 is shown until a direction is selected', async () => {
    mount(); await ready();
    expect(final()).toBeNull();
    expect(srv.finalized).toBe(0);
  });

  it('selecting a direction finalizes it: the system is shown — its visuals, version and every file — and nothing is committed', async () => {
    mount(); await ready();
    selectNth(1);
    await systemShown(1);
    const name = srv.data!.rounds[0].variations[1].name;
    expect(srv.finalized).toBe(1);
    expect(srv.publishedCalls).toBe(0);
    expect(q('[data-system-name]')!.textContent).toBe(name);
    expect(q('[data-system-version]')!.textContent).toBe('v1');
    // The visuals are the reference page itself, in a frame that can run nothing.
    const frame = q<HTMLIFrameElement>('[data-system-preview]')!;
    expect(frame.getAttribute('srcdoc')).toBe(srv.system!.html);
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('title')).toContain(name);
    // Every file the server made is listed, with what it is for — and the pointer for agents is named.
    expect([...document.querySelectorAll('[data-system-file]')].map((f) => f.getAttribute('data-system-file'))).toEqual(srv.system!.files.map((f) => f.path));
    for (const f of document.querySelectorAll('[data-system-file]')) expect(f.textContent!.length).toBeGreaterThan(f.getAttribute('data-system-file')!.length + 10);
    expect(q('[data-system-files]')!.textContent).toMatch(/CLAUDE\.md/);
    // Every repo of the project is there, none has it, and the button says exactly what it will do.
    expect(rows().map((r) => r.getAttribute('data-repo'))).toEqual(REPOS);
    for (const r of rows()) { expect(r.getAttribute('data-status')).toBe('none'); expect(r.textContent).toMatch(/Not yet/); }
    expect(q('[data-publish-state]')!.textContent).toMatch(/Not in any repo yet/);
    expect(button()!.textContent).toBe('Commit & push v1 to 4 repos');
    expect(button()!.disabled).toBe(false);
  });

  it('the button puts it in the repos, once, and every repo answers for itself — all four outcomes', async () => {
    srv.results = [
      { repoPath: REPOS[0], status: 'pushed', detail: '', branch: 'main', commit: 'aaa1111' },
      { repoPath: REPOS[1], status: 'committed', detail: 'The push was refused: the remote has commits this repo does not. Pull, then push.', branch: 'dev', commit: 'bbb2222' },
      { repoPath: REPOS[2], status: 'unchanged', detail: 'Already has version 1.', branch: 'main', commit: '' },
      { repoPath: REPOS[3], status: 'failed', detail: 'Not a git repository.', branch: '', commit: '' },
    ];
    mount(); await ready();
    selectNth(0); await systemShown(1);
    fireEvent.click(button()!);
    await waitFor(() => expect(rows()[0].getAttribute('data-status')).toBe('pushed'));
    expect(srv.publishedCalls).toBe(1);
    const want = [['pushed', /Committed and pushed/, /main · aaa1111/], ['committed', /Committed here, not pushed/, /push was refused/], ['unchanged', /Already up to date/, /Already has version 1/], ['failed', /Not published/, /Not a git repository/]] as const;
    rows().forEach((row, i) => {
      expect(row.getAttribute('data-status')).toBe(want[i][0]);
      expect(row.textContent).toMatch(want[i][1]);
      expect(row.textContent).toMatch(want[i][2]);
    });
    // Counted honestly: two of four have it.
    expect(q('[data-publish-state]')!.textContent).toMatch(/v1 is in 2 of 4 repos/);
    expect(button()!.textContent).toBe('Publish again to 4 repos');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('another direction is the next version: shown at once, and the repos are said to be behind until it is published', async () => {
    mount(); await ready();
    selectNth(0); await systemShown(1);
    fireEvent.click(button()!);
    await waitFor(() => expect(q('[data-publish-state]')!.textContent).toMatch(/v1 is in 4 of 4 repos/));
    selectNth(2); await systemShown(2);
    expect(q('[data-system-name]')!.textContent).toBe(srv.data!.rounds[0].variations[2].name);
    expect(q<HTMLIFrameElement>('[data-system-preview]')!.getAttribute('srcdoc')).toBe(srv.system!.html);
    expect(q('[data-publish-state]')!.textContent).toMatch(/The repos have v1\. v2 is ready/);
    for (const r of rows()) { expect(r.getAttribute('data-status')).toBe('none'); expect(r.textContent).toMatch(/Has v1/); }
    expect(button()!.textContent).toBe('Commit & push v2 to 4 repos');
    expect(srv.publishedCalls).toBe(1);
    fireEvent.click(button()!);
    await waitFor(() => expect(q('[data-publish-state]')!.textContent).toMatch(/v2 is in 4 of 4 repos/));
    // Un-selecting does not take the system away: it is still what the project is built with.
    fireEvent.click(q('[data-unselect]')!);
    await waitFor(() => expect(q('[data-selected-direction]')).toBeNull());
    expect(final()!.getAttribute('data-version')).toBe('2');
  });

  it('on a reload: a system that matches the selection is shown as it is; a selection with no system yet is finalized', async () => {
    mount(); await ready();
    selectNth(3); await systemShown(1);
    cleanup();
    srv.finalized = 0;
    mount(); await ready(); await systemShown(1);
    expect(srv.finalized).toBe(0);
    cleanup();
    srv.system = null;
    mount(); await ready(); await systemShown(1);
    expect(srv.finalized).toBe(1);
  });

  it('what the server made is never sent back to it', async () => {
    mount(); await ready();
    selectNth(0); await systemShown(1);
    fireEvent.click(button()!);
    await waitFor(() => expect(srv.publishedCalls).toBe(1));
    fireEvent.click(q('[data-unselect]')!);
    await waitFor(() => expect(srv.saved.length).toBeGreaterThanOrEqual(2));
    for (const body of srv.saved) for (const key of ['system', 'published', 'repos', 'updatedAt']) expect(body).not.toHaveProperty(key);
  });

  it('a project with no repos: the system is still shown, and there is nothing to publish to', async () => {
    srv.repos = [];
    mount(); await ready();
    selectNth(0); await systemShown(1);
    expect(q('[data-system-preview]')).not.toBeNull();
    expect(button()!.disabled).toBe(true);
    expect(q('[data-publish-state]')!.textContent).toMatch(/no repos yet/);
    expect(rows()).toHaveLength(0);
  });

  it('a server without step 2, or no server at all: it says a rebuild is needed, keeps the selection, and offers no button', async () => {
    srv.noStep2 = true;
    mount(); await ready();
    selectNth(0);
    await waitFor(() => expect(q('[data-needs-server]')).not.toBeNull());
    expect(q('[data-selected-direction]')).not.toBeNull();
    expect(button()).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    cleanup();
    srv.missing = true; srv.noStep2 = false; srv.finalized = 0;
    window.localStorage.setItem('neoncore.design.p1', JSON.stringify({ inspirations: [], rounds: [round()], selected: null, updatedAt: '' }));
    mount(); await ready();
    selectNth(0);
    await waitFor(() => expect(q('[data-needs-server]')).not.toBeNull());
    expect(srv.finalized).toBe(0);
    expect(button()).toBeNull();
  });

  it('a finalize or a publish that fails is said, and what was there stays', async () => {
    srv.failFinalize = 'the direction has no colours';
    mount(); await ready();
    selectNth(0);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Not finalized: the direction has no colours/));
    expect(q('[data-selected-direction]')).not.toBeNull();
    expect(q('[data-system-preview]')).toBeNull();
    srv.failFinalize = '';
    selectNth(1); await systemShown(1);
    srv.failPublish = 'This project has no repos yet';
    fireEvent.click(button()!);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Not published: This project has no repos yet/));
    expect(final()!.getAttribute('data-version')).toBe('1');
    expect(q('[data-publish-state]')!.textContent).toMatch(/Not in any repo yet/);
    expect(button()!.disabled).toBe(false);
  });
});

/**
 * THE DESIGN SYSTEM, STEP 1 — pictures in; Claude's /design, run in the project's main repo, is
 * asked for four directions; they arrive when Claude submits them; comments, "more like this" and
 * a note go with the next request; one is selected. The page designs nothing itself.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor, screen, within } from '@testing-library/react';
import type { DesignExploration, DesignInspiration, DesignRound, DesignDesigner, DesignRequestState } from '../../types';

const OK: DesignDesigner = { ok: true, agentId: 'a1', agentName: 'atlas-main', repoPath: '/code/atlas', error: '' };
const srv = vi.hoisted(() => ({
  data: { inspirations: [], rounds: [], selected: null, updatedAt: '' } as DesignExploration,
  designer: null as DesignDesigner | null, designing: null as DesignRequestState | null,
  saved: [] as DesignExploration[], asked: [] as unknown[], cancelled: 0, missing: false, failSave: false, refuse: '', queued: false,
}));
vi.mock('../../lib/api', () => {
  const whole = () => ({ ...srv.data, designer: srv.designer, designing: srv.designing, repos: [], system: null, published: null });
  return { api: {
    getDesignSystem: () => (srv.missing ? Promise.reject(new Error('Not Found')) : Promise.resolve(whole())),
    saveDesignSystem: (_id: string, body: DesignExploration) => {
      if (srv.missing) return Promise.reject(new Error('Not Found'));
      if (srv.failSave) return Promise.reject(new Error('disk full'));
      srv.saved.push(JSON.parse(JSON.stringify(body)));
      // As the server does: a round the designer delivered that the page has not seen is kept.
      const sent = new Set(body.rounds.map((r) => r.id));
      srv.data = { ...body, rounds: [...body.rounds, ...srv.data.rounds.filter((r) => r.by && !sent.has(r.id))], updatedAt: 'now' };
      return Promise.resolve(whole());
    },
    requestDesign: (_id: string, ask: unknown) => {
      if (srv.refuse) return Promise.reject(new Error(srv.refuse));
      srv.asked.push(JSON.parse(JSON.stringify(ask)));
      srv.designing = { id: `req-${srv.asked.length}`, status: 'pending', queued: srv.queued, error: '', agentName: 'atlas-main', createdAt: 'now', dispatchedAt: srv.queued ? null : 'now' };
      return Promise.resolve(whole());
    },
    cancelDesign: () => { srv.cancelled++; srv.designing = { ...srv.designing!, status: 'failed', error: 'Cancelled' }; return Promise.resolve(whole()); },
    finalizeDesignSystem: () => Promise.reject(new Error('Not Found')),
  } };
});

import { DesignSystemTab, MAX_INSPIRATIONS } from '../DesignSystemTab';
import { proposeRound } from '../../lib/design/designer';

const project = { id: 'p1', name: 'Atlas' } as never;
let n = 0;
const read = (file: File): Promise<DesignInspiration> => Promise.resolve({ id: `pic-${++n}`, name: file.name, dataUrl: 'data:image/jpeg;base64,AAAA', colors: ['#ff3b30', '#0a84ff', '#111111'] });
const file = (name: string, type = 'image/png') => new File(['x'], name, { type });
const picture = (id: string): DesignInspiration => ({ id, name: `${id}.png`, dataUrl: 'data:image/jpeg;base64,AAAA', colors: ['#ff3b30', '#0a84ff', '#111111'] });
/** What Claude submits: four directions (the fixture borrows token sets; the page never makes them). */
const claudeRound = (id: string, rounds: DesignRound[] = []): DesignRound => ({
  id, at: '2026-11-21T10:00:00Z', by: 'atlas-main', canvasUrl: `https://claude.ai/artifact/${id}`,
  ...proposeRound({ colors: ['#ff3b30', '#0a84ff', '#111111'], rounds, feedback: '', base: null }),
});
/** Claude finishes: the round is on the server, the request is answered. */
const claudeSubmits = (id: string) => {
  srv.data = { ...srv.data, rounds: [...srv.data.rounds, claudeRound(id, srv.data.rounds)] };
  srv.designing = { ...srv.designing!, status: 'ready' };
};
const mount = () => render(<DesignSystemTab project={project} read={read} pollMs={15} />);
const ready = () => waitFor(() => expect(document.querySelector('[data-design-system]')).not.toBeNull());
const q = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const add = (...files: File[]) => fireEvent.change(screen.getByLabelText('Inspiration pictures'), { target: { files } });
const cards = () => [...document.querySelectorAll<HTMLElement>('section[data-round] > div > [data-variation]')];
const designButton = () => q<HTMLButtonElement>('[data-design]')!;
const last = () => srv.saved[srv.saved.length - 1];

beforeEach(() => {
  Object.assign(srv, { data: { inspirations: [], rounds: [], selected: null, updatedAt: '' }, designer: { ...OK }, designing: null,
    saved: [], asked: [], cancelled: 0, missing: false, failSave: false, refuse: '', queued: false });
  n = 0; window.localStorage.clear();
});
afterEach(() => cleanup());

describe('the design system — step 1: Claude’s /design finds the direction', () => {
  it('says who designs — Claude’s /design, on which cartridge, in which repo — and nothing on the page is simulated', async () => {
    mount(); await ready();
    const who = q('[data-designer]')!;
    expect(who.getAttribute('data-ok')).toBe('yes');
    expect(who.textContent).toMatch(/Claude \/design/);
    expect(who.textContent).toContain('atlas-main');
    expect(who.textContent).toContain('(atlas)');
    expect(document.body.textContent).not.toMatch(/simulated/i);
    // Nothing to design from yet.
    expect(designButton().disabled).toBe(true);
    expect(cards()).toHaveLength(0);
  });

  it('with no Claude cartridge on the main repo it says why, and cannot be asked', async () => {
    srv.designer = { ok: false, agentId: '', agentName: '', repoPath: '/code/atlas', error: 'No Claude cartridge is open on /code/atlas. Open one there — /design runs in the project\'s main repo — then ask again.' };
    srv.data = { ...srv.data, inspirations: [picture('a')] };
    mount(); await ready();
    expect(q('[data-designer]')!.getAttribute('data-ok')).toBe('no');
    expect(q('[data-designer]')!.textContent).toMatch(/No Claude cartridge is open on \/code\/atlas/);
    expect(designButton().disabled).toBe(true);
    fireEvent.click(designButton());
    expect(srv.asked).toHaveLength(0);
  });

  it('pictures: added pictures are shown with their colours and kept; only pictures are taken; one can be removed; eight is the most', async () => {
    mount(); await ready();
    add(file('a.png'), file('notes.txt', 'text/plain'), file('b.jpg', 'image/jpeg'));
    await waitFor(() => expect(document.querySelectorAll('[data-picture]')).toHaveLength(2));
    expect(last().inspirations.map((p) => p.name)).toEqual(['a.png', 'b.jpg']);
    for (const pic of document.querySelectorAll('[data-picture]')) expect(pic.querySelectorAll('span[title^="#"]').length).toBe(3);
    fireEvent.click(screen.getByLabelText('Remove a.png'));
    await waitFor(() => expect(document.querySelectorAll('[data-picture]')).toHaveLength(1));
    expect(last().inspirations.map((p) => p.name)).toEqual(['b.jpg']);
    add(...Array.from({ length: 10 }, (_, i) => file(`m${i}.png`)));
    await waitFor(() => expect(document.querySelectorAll('[data-picture]')).toHaveLength(MAX_INSPIRATIONS));
    expect(screen.getByRole('alert').textContent).toMatch(/8 pictures is the most/);
    expect(last().inspirations).toHaveLength(MAX_INSPIRATIONS);
  });

  it('asking for a round sends ONE request to Claude; the page waits, and the four directions appear when Claude submits them — with the canvas', async () => {
    srv.data = { ...srv.data, inspirations: [picture('a')] };
    mount(); await ready();
    expect(designButton().disabled).toBe(false);
    fireEvent.click(designButton());
    await waitFor(() => expect(q('[data-designing]')).not.toBeNull());
    expect(srv.asked).toEqual([{ note: '', basedOn: null }]);
    expect(q('[data-designing]')!.getAttribute('data-queued')).toBe('no');
    expect(q('[data-designing]')!.textContent).toMatch(/Claude is designing four directions in atlas-main/);
    // While it designs: nothing invented here, and it cannot be asked twice.
    expect(cards()).toHaveLength(0);
    expect(designButton().disabled).toBe(true);
    fireEvent.click(designButton());
    expect(srv.asked).toHaveLength(1);

    claudeSubmits('r1');
    await waitFor(() => expect(cards()).toHaveLength(4));
    expect(q('[data-designing]')).toBeNull();
    const round = srv.data.rounds[0];
    cards().forEach((card, i) => {
      expect(card.querySelector('[data-variation-name]')!.textContent).toBe(round.variations[i].name);
      expect(card.textContent).toContain(round.variations[i].rationale);
      expect(card.querySelector('[data-design-preview]')!.getAttribute('data-primary')).toBe(round.variations[i].tokens.colors.primary);
    });
    const head = q('section[data-round]')!;
    expect(head.textContent).toMatch(/Designed by atlas-main with \/design/);
    const link = q<HTMLAnchorElement>('[data-canvas-link]')!;
    expect(link.getAttribute('href')).toBe('https://claude.ai/artifact/r1');
    expect(link.getAttribute('target')).toBe('_blank');
    // The page made no round of its own: nothing it saved has one.
    for (const body of srv.saved) expect(body.rounds).toHaveLength(0);
  });

  it('a busy cartridge: the page says it is waiting for it; "Stop waiting" closes the request and it can be asked again', async () => {
    srv.data = { ...srv.data, inspirations: [picture('a')] };
    srv.queued = true;
    mount(); await ready();
    fireEvent.click(designButton());
    await waitFor(() => expect(q('[data-designing]')).not.toBeNull());
    expect(q('[data-designing]')!.getAttribute('data-queued')).toBe('yes');
    expect(q('[data-designing]')!.textContent).toMatch(/Waiting for atlas-main to finish/);
    fireEvent.click(q('[data-cancel-design]')!);
    await waitFor(() => expect(q('[data-designing]')).toBeNull());
    expect(srv.cancelled).toBe(1);
    expect(q('[data-design-failed]')).toBeNull();
    expect(designButton().disabled).toBe(false);
  });

  it('a round that does not arrive is said, with the reason — on a reload too — and can be asked again; a refused request is said', async () => {
    srv.data = { ...srv.data, inspirations: [picture('a')] };
    srv.designing = { id: 'req-0', status: 'failed', queued: false, error: 'Claude finished without submitting its directions. Look at the cartridge to see why, then ask again.', agentName: 'atlas-main', createdAt: 'x', dispatchedAt: 'x' };
    mount(); await ready();
    expect(q('[data-design-failed]')!.textContent).toMatch(/did not arrive: Claude finished without submitting/);
    expect(designButton().disabled).toBe(false);
    srv.refuse = 'A round is already being designed';
    fireEvent.click(designButton());
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Not sent to the designer: A round is already being designed/));
    srv.refuse = '';
    fireEvent.click(designButton());
    await waitFor(() => expect(q('[data-designing]')).not.toBeNull());
    expect(q('[data-design-failed]')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('comments are kept on their direction; the note and "More like this" go to Claude with the next request, and the page says what it is told', async () => {
    srv.data = { ...srv.data, inspirations: [picture('a')], rounds: [claudeRound('r1')] };
    mount(); await ready();
    await waitFor(() => expect(cards()).toHaveLength(4));
    const r1 = srv.data.rounds[0];
    const box = within(cards()[0]).getByLabelText(`Comment on ${r1.variations[0].name}`);
    fireEvent.change(box, { target: { value: 'too cold' } });
    fireEvent.submit(box.closest('form')!);
    await waitFor(() => expect(last()?.rounds[0].variations[0].comments.map((c) => c.text)).toEqual(['too cold']));
    expect(cards()[0].textContent).toContain('too cold');
    fireEvent.click(within(cards()[2]).getByText(/More like this/));
    fireEvent.change(screen.getByLabelText('What should change in the next round'), { target: { value: 'rounder corners' } });
    expect(q('[data-brief]')!.textContent).toBe(`Claude is told: your note · 1 comment · more like “${r1.variations[2].name}”`);
    fireEvent.click(designButton());
    await waitFor(() => expect(srv.asked).toEqual([{ note: 'rounder corners', basedOn: { roundId: 'r1', variationId: r1.variations[2].id } }]));
    // The note and the "more like" choice are spent once sent.
    await waitFor(() => expect((screen.getByLabelText('What should change in the next round') as HTMLTextAreaElement).value).toBe(''));
    claudeSubmits('r2');
    await waitFor(() => expect(q('section[data-round]')!.getAttribute('data-round')).toBe('r2'));
    expect(screen.getByText(/Earlier rounds \(1\)/)).toBeTruthy();
    // A comment made now is saved with BOTH rounds: the one Claude delivered is not lost.
    const box2 = within(cards()[1]).getByLabelText(`Comment on ${srv.data.rounds[1].variations[1].name}`);
    fireEvent.change(box2, { target: { value: 'yes' } });
    fireEvent.submit(box2.closest('form')!);
    await waitFor(() => expect(last().rounds.map((r) => r.id)).toEqual(['r1', 'r2']));
  });

  it('selecting a direction finishes step 1, shows it at the top, survives a reload, and can be undone or changed — from any round', async () => {
    srv.data = { ...srv.data, inspirations: [picture('a')], rounds: [claudeRound('r1')] };
    srv.data.rounds.push(claudeRound('r2', srv.data.rounds));
    const view = mount(); await ready();
    await waitFor(() => expect(cards()).toHaveLength(4));
    expect(q('[data-selected-direction]')).toBeNull();
    fireEvent.click(within(cards()[3]).getByText('Select this one'));
    await waitFor(() => expect(last().selected).toEqual({ roundId: 'r2', variationId: srv.data.rounds[1].variations[3].id }));
    const banner = q('[data-selected-direction]')!;
    expect(banner.textContent).toContain(srv.data.rounds[1].variations[3].name);
    expect(banner.textContent).toMatch(/step 1 done/);
    expect(document.querySelectorAll('[data-variation][data-selected]')).toHaveLength(1);
    fireEvent.click(screen.getByText(/Earlier rounds/));
    fireEvent.click(within(q('[data-earlier]')!).getAllByText('Select')[0]);
    await waitFor(() => expect(last().selected).toEqual({ roundId: 'r1', variationId: srv.data.rounds[0].variations[0].id }));
    expect(q('[data-selected-direction]')!.textContent).toContain(srv.data.rounds[0].variations[0].name);
    view.unmount();
    mount(); await ready();
    await waitFor(() => expect(q('[data-selected-direction]')).not.toBeNull());
    expect(cards()).toHaveLength(4);
    fireEvent.click(q('[data-unselect]')!);
    await waitFor(() => expect(last().selected).toBeNull());
    expect(q('[data-selected-direction]')).toBeNull();
  });

  it('a server without the design system: pictures are kept in this browser, the page says so, and Claude cannot be asked from here', async () => {
    srv.missing = true;
    mount(); await ready();
    add(file('a.png'));
    await waitFor(() => expect(document.querySelectorAll('[data-picture]')).toHaveLength(1));
    expect(q('[data-kept-in-browser]')).not.toBeNull();
    expect(q('[data-designer]')!.textContent).toMatch(/Rebuild and restart/);
    expect(designButton().disabled).toBe(true);
    expect(JSON.parse(window.localStorage.getItem('neoncore.design.p1')!).inspirations).toHaveLength(1);
  });

  it('a save that fails is said, and what is on screen stays', async () => {
    srv.data = { ...srv.data, inspirations: [picture('a')], rounds: [claudeRound('r1')] };
    mount(); await ready();
    await waitFor(() => expect(cards()).toHaveLength(4));
    srv.failSave = true;
    fireEvent.click(within(cards()[0]).getByText('Select this one'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Not saved: disk full/));
    expect(cards()).toHaveLength(4);
    expect(q('[data-selected-direction]')).not.toBeNull();
  });
});

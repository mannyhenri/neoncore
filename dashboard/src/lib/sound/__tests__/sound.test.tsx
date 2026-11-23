/**
 * SOUND — every cue, every rule that keeps it sparse, every setting. No speaker needed: the rules
 * are pure, and the engine is silent where there is no Web Audio (here).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CUES, CUE_SPECS, UI_SOUNDS, QUIET_START_MS, SHADOW_MS, CUES_PER_MINUTE, NOTIFICATION_KINDS, cueForNotification, createCueGate, type Cue } from '../cues';
import { SOUND_FILES, SOUND_PACKS } from '../sounds.generated';
import { THEMES } from '../../../world/theme';
import { DEFAULT_SOUND, SOUND_KEY, parseSound, getSound, setSound } from '../settings';
import { cuesFor, type SoundWatch } from '../useSoundEvents';
import { uiSoundFor, playCue, playUi } from '../engine';
import { SoundButton, SoundSettingsPanel } from '../../../components/SoundControls';

const PUBLIC = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../public');
afterEach(() => { cleanup(); setSound({ ...DEFAULT_SOUND }); });

describe('the sound files', () => {
  it('there are fourteen: five interface sounds and one cue per kind of event — each a real file, and NO background loop', () => {
    const ids = Object.keys(SOUND_FILES);
    expect(ids.sort()).toEqual([...UI_SOUNDS, ...CUES.map((c) => CUE_SPECS[c].sound)].sort());
    expect(ids).toHaveLength(14);
    // Nothing plays between sounds: no ambient file in any theme, shipped or left behind.
    for (const dir of ['sound', 'sound/fantasy']) expect(existsSync(resolve(PUBLIC, dir, 'ambient.mp3')), dir).toBe(false);
    for (const id of ids) expect(SOUND_FILES[id as keyof typeof SOUND_FILES].seconds, id).toBeLessThan(2.5);
    let total = 0;
    for (const [id, f] of Object.entries(SOUND_FILES)) {
      const path = resolve(PUBLIC, `.${f.src}`);
      expect(existsSync(path), id).toBe(true);
      expect(statSync(path).size, id).toBeGreaterThan(1000);
      total += statSync(path).size;
      expect(f.seconds).toBeGreaterThan(0);
    }
    // Small enough to ship.
    expect(total).toBeLessThan(400 * 1024);
    // Interface sounds are short, and cues are brief.
    for (const id of UI_SOUNDS) expect(SOUND_FILES[id].seconds, id).toBeLessThan(0.6);
    for (const c of CUES) expect(SOUND_FILES[CUE_SPECS[c].sound].seconds, c).toBeLessThan(2.5);
  });
  it('each cue has its own sound and its own rank, and exactly four are warnings', () => {
    expect(new Set(CUES.map((c) => CUE_SPECS[c].sound)).size).toBe(CUES.length);
    expect(new Set(CUES.map((c) => CUE_SPECS[c].rank)).size).toBe(CUES.length);
    expect(CUES.filter((c) => CUE_SPECS[c].warning).sort()).toEqual(['failed', 'needs-you', 'quota', 'stuck']);
    // A warning always outranks something that is not one.
    const lowestWarning = Math.min(...CUES.filter((c) => CUE_SPECS[c].warning).map((c) => CUE_SPECS[c].rank));
    for (const c of CUES) if (!CUE_SPECS[c].warning) expect(CUE_SPECS[c].rank, c).toBeLessThan(lowestWarning);
  });
});

describe('the sound sets', () => {
  it('every world theme has its own set of the same fourteen sounds — each a real file, none shared with another theme', () => {
    expect(Object.keys(SOUND_PACKS).sort()).toEqual([...THEMES].sort());
    const seen = new Set<string>();
    for (const theme of THEMES) {
      const pack = SOUND_PACKS[theme];
      expect(Object.keys(pack).sort(), theme).toEqual(Object.keys(SOUND_FILES).sort());
      let total = 0;
      for (const [id, f] of Object.entries(pack)) {
        const path = resolve(PUBLIC, `.${f.src}`);
        expect(existsSync(path), `${theme}/${id}`).toBe(true);
        expect(statSync(path).size, `${theme}/${id}`).toBeGreaterThan(1000);
        expect(seen.has(f.src), `${f.src} is used twice`).toBe(false);
        seen.add(f.src);
        total += statSync(path).size;
        // The same shape in every theme: a cue is as long in the village as on the outpost.
        expect(Math.abs(f.seconds - SOUND_FILES[id as keyof typeof SOUND_FILES].seconds), `${theme}/${id}`).toBeLessThan(0.3);
      }
      expect(total, theme).toBeLessThan(400 * 1024);
    }
    expect(seen.size).toBe(THEMES.length * 14);
  });
});

describe('a notification\'s cue', () => {
  it('is the kind the server gave it — for every kind', () => {
    const want: Record<string, Cue> = { 'needs-you': 'needs-you', failed: 'failed', finished: 'run-finished', notice: 'notice' };
    for (const kind of NOTIFICATION_KINDS) expect(cueForNotification({ kind, title: 'Run — Done' }), kind).toBe(want[kind]);
  });
  it('is read off the title when an older server gave no kind — for every title the server writes', () => {
    const titles: [string, Cue][] = [
      ['Deploy — Ready to advance', 'needs-you'], ['Deploy — Needs a decision', 'needs-you'], ['Invoices — 3 questions to answer', 'needs-you'],
      ['Invoices — plan ready to review', 'needs-you'], ['Invoices — checklist verdicts to confirm', 'needs-you'], ['Invoices — stage 2 needs a claude cartridge', 'needs-you'],
      ['Deploy — Step failed', 'failed'], ['Deploy — Step interrupted', 'failed'], ['Invoices — the pipeline stopped and needs you', 'failed'],
      ['Invoices — the planner did not answer', 'failed'], ['Invoices — locked acceptance tests were changed', 'failed'], ['Goal over budget', 'failed'],
      ['Deploy — Done', 'run-finished'], ['Deploy — Done · Atlas', 'run-finished'], ['Invoices — feature report ready — passed', 'run-finished'],
      ['Goal approaching budget', 'notice'], ['Something else', 'notice'],
    ];
    for (const [title, cue] of titles) expect(cueForNotification({ title }), title).toBe(cue);
    expect(cueForNotification({ kind: 'nonsense', title: 'Deploy — Done' })).toBe('run-finished');
  });
});

describe('the rules that keep it sparse', () => {
  const T0 = 1_000_000;
  const open = () => createCueGate(T0);
  const later = T0 + QUIET_START_MS;

  it('nothing plays in the first 6 seconds — for every cue', () => {
    for (const cue of CUES) {
      const g = open();
      expect(g.allow(cue, T0), cue).toBe(false);
      expect(g.allow(cue, T0 + QUIET_START_MS - 1), cue).toBe(false);
      expect(g.allow(cue, later), cue).toBe(true);
    }
  });
  it('the same cue is one sound however many arrive at once, and again only after its cooldown — for every cue', () => {
    for (const cue of CUES) {
      const g = open();
      expect([0, 1, 2, 3, 4].map((i) => g.allow(cue, later + i)), cue).toEqual([true, false, false, false, false]);
      expect(g.allow(cue, later + CUE_SPECS[cue].cooldownMs - 1), cue).toBe(false);
      expect(g.allow(cue, later + CUE_SPECS[cue].cooldownMs), cue).toBe(true);
    }
  });
  it('a less important cue within 3 seconds of a more important one is dropped; the other way round it plays — every pair', () => {
    for (const a of CUES) for (const b of CUES) {
      if (a === b) continue;
      const g = open();
      expect(g.allow(a, later)).toBe(true);
      const outranked = CUE_SPECS[a].rank > CUE_SPECS[b].rank;
      expect(g.allow(b, later + SHADOW_MS - 1), `${b} after ${a}`).toBe(!outranked);
      if (outranked) expect(g.allow(b, later + SHADOW_MS), `${b} 3 s after ${a}`).toBe(true);
    }
  });
  it('at most 8 cues a minute — but the warnings always get through', () => {
    const g = open();
    const quiet = CUES.filter((c) => !CUE_SPECS[c].warning);
    let played = 0;
    // Rotate through the quiet cues, far enough apart that neither cooldown nor shadow is the reason.
    for (let i = 0; i < 12; i++) if (g.allow(quiet[i % quiet.length], later + i * 4000)) played++;
    expect(played).toBeLessThanOrEqual(CUES_PER_MINUTE);
    const full = later + 12 * 4000;
    for (const c of quiet) expect(g.allow(c, full + 11_000), `${c} over the cap`).toBe(false);
    // (4 s apart: within 3 s a warning would rightly give way to a more important one.)
    CUES.filter((x) => CUE_SPECS[x].warning).forEach((c, i) => expect(g.allow(c, full + 12_000 + i * 4000), `${c} is a warning`).toBe(true));
    // A minute on, the cap has cleared.
    expect(g.allow('notice', full + 80_000)).toBe(true);
  });
  it('in a background tab only the warnings play — for every cue', () => {
    for (const cue of CUES) expect(open().allow(cue, later, { hidden: true }), cue).toBe(CUE_SPECS[cue].warning);
  });
});

describe('what happened → which cue', () => {
  const base: SoundWatch = { agents: [], pendingPermissions: [], stuckAlerts: [], workflowNotifications: [], tasks: [], delivered: new Map(), quotaPct: 50 };
  const cases: [string, Partial<SoundWatch>, Partial<SoundWatch>, Cue[]][] = [
    ['nothing changed', {}, {}, []],
    ['an approval arrived', {}, { pendingPermissions: [{ id: 'p1' }] }, ['needs-you']],
    ['ten approvals at once', {}, { pendingPermissions: Array.from({ length: 10 }, (_, i) => ({ id: `p${i}` })) }, ['needs-you']],
    ['an approval was answered', { pendingPermissions: [{ id: 'p1' }] }, {}, []],
    ['an agent looks stuck', {}, { stuckAlerts: [{ agentId: 'a' }] }, ['stuck']],
    ['the same agent is still stuck', { stuckAlerts: [{ agentId: 'a' }] }, { stuckAlerts: [{ agentId: 'a' }] }, []],
    ['a run needs you', {}, { workflowNotifications: [{ id: 'n', title: 'x', kind: 'needs-you' }] }, ['needs-you']],
    ['a run failed', {}, { workflowNotifications: [{ id: 'n', title: 'x', kind: 'failed' }] }, ['failed']],
    ['a run finished', {}, { workflowNotifications: [{ id: 'n', title: 'x', kind: 'finished' }] }, ['run-finished']],
    ['a notice', {}, { workflowNotifications: [{ id: 'n', title: 'x', kind: 'notice' }] }, ['notice']],
    ['a notification was dismissed', { workflowNotifications: [{ id: 'n', title: 'x', kind: 'failed' }] }, {}, []],
    ['a cartridge came online', {}, { agents: [{ id: 'a', status: 'idle' }] }, ['launched']],
    ['an offline cartridge came back', { agents: [{ id: 'a', status: 'offline' }] }, { agents: [{ id: 'a', status: 'working' }] }, ['launched']],
    ['an offline cartridge is listed', {}, { agents: [{ id: 'a', status: 'offline' }] }, []],
    ['an agent finished its turn', { agents: [{ id: 'a', status: 'working' }] }, { agents: [{ id: 'a', status: 'idle' }] }, ['turn-finished']],
    ['an agent started working', { agents: [{ id: 'a', status: 'idle' }] }, { agents: [{ id: 'a', status: 'working' }] }, []],
    ['an agent stopped to ask', { agents: [{ id: 'a', status: 'working' }] }, { agents: [{ id: 'a', status: 'waiting' }] }, []],
    ['a task failed', { tasks: [{ id: 't', status: 'in_progress' }] }, { tasks: [{ id: 't', status: 'failed' }] }, ['failed']],
    ['a task was done', { tasks: [{ id: 't', status: 'in_progress' }] }, { tasks: [{ id: 't', status: 'done' }] }, ['turn-finished']],
    ['a task that was already failed', { tasks: [{ id: 't', status: 'failed' }] }, { tasks: [{ id: 't', status: 'failed' }] }, []],
    ['a feature was delivered', { delivered: new Map([['p', 2]]) }, { delivered: new Map([['p', 3]]) }, ['delivered']],
    ['a project appeared with deliveries', {}, { delivered: new Map([['p', 3]]) }, []],
    ['a delivery was undone', { delivered: new Map([['p', 3]]) }, { delivered: new Map([['p', 2]]) }, []],
    ['the quota crossed 90%', { quotaPct: 89 }, { quotaPct: 90 }, ['quota']],
    ['the quota is still over 90%', { quotaPct: 93 }, { quotaPct: 95 }, []],
    ['the quota crossed 80%', { quotaPct: 79 }, { quotaPct: 85 }, []],
    ['the first quota reading is over 90%', { quotaPct: null }, { quotaPct: 95 }, []],
  ];
  it.each(cases)('%s', (_name, before, after, want) => {
    expect(cuesFor({ ...base, ...before }, { ...base, ...before, ...after }).sort()).toEqual([...want].sort());
  });
  it('every cue has something that sets it off', () => {
    expect([...new Set(cases.flatMap((c) => c[3]))].sort()).toEqual([...CUES].sort());
  });
});

describe('the settings', () => {
  it('whatever is stored comes back as valid settings', () => {
    expect(parseSound(null)).toEqual(DEFAULT_SOUND);
    for (const raw of ['', 'not json', '[]', '42', 'null', '{"volume":"loud"}']) expect(parseSound(raw), raw).toEqual(DEFAULT_SOUND);
    // (an `ambient` level saved by an earlier version is simply dropped)
    expect(parseSound('{"muted":true,"volume":2,"ambient":0.35,"ui":false,"cues":false}')).toEqual({ muted: true, volume: 1, ui: false, cues: false });
    expect(parseSound('{"volume":0.25}')).toEqual({ ...DEFAULT_SOUND, volume: 0.25 });
  });
  it('are kept in the browser, and a muted or switched-off app plays nothing', () => {
    setSound({ volume: 0.4 });
    expect(JSON.parse(window.localStorage.getItem(SOUND_KEY)!).volume).toBe(0.4);
    setSound({ muted: true });
    expect(playCue('failed')).toBe(false);
    setSound({ muted: false, cues: false });
    expect(playCue('failed')).toBe(false);
    expect(() => { playUi('ui-tap'); playUi('ui-send'); }).not.toThrow();
  });
});

describe('the controls', () => {
  it('the speaker button mutes and unmutes everything, and says which it is', () => {
    const { container } = render(<SoundButton />);
    const button = container.querySelector<HTMLButtonElement>('[data-sound-button]')!;
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    expect(getSound().muted).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.getAttribute('aria-label')).toMatch(/off/);
    fireEvent.click(button);
    expect(getSound().muted).toBe(false);
  });
  it('Settings → Sound has every level, every switch, and a preview for every cue', () => {
    const { container } = render(<SoundSettingsPanel />);
    expect([...container.querySelectorAll('[data-sound-level]')].map((e) => e.getAttribute('data-sound-level'))).toEqual(['volume']);
    expect([...container.querySelectorAll('[data-sound-switch]')].map((e) => e.getAttribute('data-sound-switch'))).toEqual(['muted', 'ui', 'cues']);
    expect([...container.querySelectorAll('[data-cue]')].map((e) => e.getAttribute('data-cue'))).toEqual([...CUES]);
    for (const row of container.querySelectorAll('[data-cue]')) expect(row.querySelector('button')!.textContent).toBe('Preview');
    fireEvent.change(container.querySelector('[data-sound-level="volume"]')!, { target: { value: '30' } });
    fireEvent.click(container.querySelector('[data-sound-switch="ui"]')!);
    fireEvent.click(container.querySelector('[data-sound-switch="cues"]')!);
    fireEvent.click(container.querySelector('[data-sound-switch="muted"]')!);
    expect(getSound()).toEqual({ muted: true, volume: 0.3, ui: false, cues: false });
    expect(() => fireEvent.click(container.querySelector('[data-cue="failed"] button')!)).not.toThrow();
  });
  it('a click makes a tap, a primary button a brighter one — and nothing on a disabled control, plain text or a preview button', () => {
    document.body.innerHTML = `
      <button id="b">x</button><button id="p" class="btn-primary">x</button><button id="d" disabled>x</button>
      <div role="tab" id="t"><span id="inner">x</span></div><a href="#x" id="a">x</a><p id="text">x</p>
      <button id="q" data-sound="none">Preview</button><input type="checkbox" id="c" />`;
    const of = (id: string) => uiSoundFor(document.getElementById(id));
    expect([of('b'), of('p'), of('d'), of('t'), of('inner'), of('a'), of('text'), of('q'), of('c')])
      .toEqual(['ui-tap', 'ui-primary', null, 'ui-tap', 'ui-tap', 'ui-tap', null, null, 'ui-tap']);
    expect(uiSoundFor(null)).toBeNull();
    document.body.innerHTML = '';
  });
});

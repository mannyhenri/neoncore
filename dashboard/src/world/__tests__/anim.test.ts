import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ANIMATIONS, ANIMATION_NAMES, animationFor, WORK_POSTURES, WORK_CYCLE } from '../anim';
import { CREW_SHEETS, sheetFor } from '../sheets';
import { CREW_STATUSES, ATTENTION_ORDER } from '../crew';
import { PLATES } from '../sites';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORLD = resolve(HERE, '..');

/**
 * EVERY ANIMATION, EVERY STATE — AND NO CODE-DRAWN FIGURES.
 *
 * "Please remove your ugly code drawn ones, I don't want them and didn't ask for them. We'll
 * have the sprites for this." So the avatars are drawn sprite sheets or nothing: this file
 * checks the registry and the state mapping as sets, checks every registered sheet against
 * the registry, and fails if a figure drawn from code ever comes back.
 */
describe('avatar animations', () => {
  it('the registry has the ten cycles the scene uses', () => {
    expect([...ANIMATION_NAMES].sort()).toEqual(['alert', 'call', 'idle', 'jump', 'kneel', 'repair', 'rest', 'tend', 'walk', 'work']);
    expect(Object.keys(ANIMATIONS).sort()).toEqual([...ANIMATION_NAMES].sort());
    for (const name of ANIMATION_NAMES) expect(ANIMATIONS[name].fps, name).toBeGreaterThan(0);
  });

  it('every crew state plays an animation, and walking overrides all of them', () => {
    for (const status of CREW_STATUSES) {
      for (const attention of [null, ...ATTENTION_ORDER]) {
        const still = animationFor({ status, attention }, false);
        expect(ANIMATION_NAMES, `${status}/${attention}`).toContain(still);
        expect(animationFor({ status, attention }, true)).toBe('walk');
        // Stuck calls out; everything else that needs you waves.
        if (attention) expect(still, `${attention} must be visible as motion`).toBe(attention === 'stuck' ? 'call' : 'alert');
        // A finished turn jumps, whatever else is true — except while walking.
        expect(animationFor({ status, attention }, false, 'stand', { cheering: true })).toBe('jump');
        expect(animationFor({ status, attention }, true, 'stand', { cheering: true })).toBe('walk');
      }
    }
    expect(animationFor({ status: 'working', attention: null }, false)).toBe('kneel');
    for (const posture of WORK_POSTURES) {
      expect(animationFor({ status: 'working', attention: null }, false, posture)).toBe(WORK_CYCLE[posture]);
      expect(animationFor({ status: 'working', attention: null }, true, posture)).toBe('walk');
      expect(animationFor({ status: 'working', attention: 'approval' }, false, posture)).toBe('alert');
      expect(animationFor({ status: 'idle', attention: null }, false, posture)).toBe('idle');
    }
    expect(animationFor({ status: 'idle', attention: null }, false)).toBe('idle');
    expect(animationFor({ status: 'waiting', attention: null }, false)).toBe('alert');
  });

  it('every work posture has a cycle, and every one of them is floor work', () => {
    expect([...WORK_POSTURES].sort()).toEqual(['kneel', 'repair', 'stand', 'tend']);
    expect(Object.keys(WORK_CYCLE).sort()).toEqual([...WORK_POSTURES].sort());
    for (const p of WORK_POSTURES) expect(['kneel', 'repair', 'tend'], p).toContain(WORK_CYCLE[p]);
  });

  it.each(PLATES.flatMap((p) => p.sites.map((site) => ({ name: `${p.id}/${site.id}`, site }))))('$name declares how work is done there and which way to face', ({ site }) => {
    expect(WORK_POSTURES).toContain(site.work);
    expect([1, -1]).toContain(site.faces);
  });

  it.each(PLATES.map((p) => ({ name: p.id, plate: p })))('$name has a site for every way of working', ({ plate }) => {
    for (const posture of WORK_POSTURES) expect(plate.sites.some((s) => s.work === posture), posture).toBe(true);
  });

  it('the stylesheet has the stepped strip animation, and stops it for reduced motion', () => {
    const css = readFileSync(resolve(HERE, '../../index.css'), 'utf8');
    expect(css).toMatch(/@keyframes world-strip/);
    const reduced = css.slice(css.indexOf('prefers-reduced-motion: reduce', css.indexOf('world-strip')));
    expect(reduced).toMatch(/\.world-strip[^}]*animation:\s*none/);
  });
});

describe('crew sprite sheets', () => {
  it('an unknown character draws nothing rather than a stand-in', () => {
    expect(sheetFor('nobody')).toBeNull();
    expect(Object.keys(CREW_SHEETS).length).toBeGreaterThanOrEqual(3);
  });

  // Set-based over whatever is registered: empty today, checked automatically as sheets land.
  it.each(Object.entries(CREW_SHEETS).map(([character, sheet]) => ({ character, sheet: sheet! })))('$character sheet: the file exists and it has a row for every animation', ({ sheet }) => {
    expect(existsSync(resolve(HERE, '../../../public', sheet.src.replace(/^\//, ''))), `${sheet.src} is missing from public/`).toBe(true);
    expect(sheet.frameW).toBeGreaterThan(0);
    expect(sheet.frameH).toBeGreaterThan(0);
    expect(Object.keys(sheet.rows).sort()).toEqual([...ANIMATION_NAMES].sort());
    const rows = new Set<number>();
    for (const name of ANIMATION_NAMES) {
      expect(sheet.rows[name].frames, name).toBeGreaterThanOrEqual(2);
      // Where the character's head (or raised hand) starts in the cell — the panel sits just above it.
      expect(sheet.rows[name].top, name).toBeGreaterThanOrEqual(0);
      expect(sheet.rows[name].top, name).toBeLessThan(0.6);
      rows.add(sheet.rows[name].row);
    }
    expect(rows.size, 'two animations point at the same row').toBe(ANIMATION_NAMES.length);
    // The image really is the grid the registry describes (read from the PNG header).
    const png = readFileSync(resolve(HERE, '../../../public', sheet.src.replace(/^\//, '')));
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    const cols = Math.max(...ANIMATION_NAMES.map((n) => sheet.rows[n].frames));
    expect(width, 'atlas width').toBe(sheet.frameW * cols);
    expect(height, 'atlas height').toBe(sheet.frameH * ANIMATION_NAMES.length);
    expect(png[25], 'atlas must have an alpha channel (colour type 6)').toBe(6);
  });

  it('nothing in the World view draws a figure from code', () => {
    const files = readdirSync(WORLD).filter((f) => /\.tsx?$/.test(f));
    expect(files.length).toBeGreaterThan(3);
    for (const f of files) {
      const src = readFileSync(resolve(WORLD, f), 'utf8');
      // The retired placeholder: character maps stacked into frames and painted as rects.
      expect(src, `${f} still has a character map`).not.toMatch(/'[.hsebdkt]{10,}'/);
      expect(src, `${f} still paints pixels as rects`).not.toMatch(/<rect\b|<ellipse\b|framesFor|FRAME_W|compose\(/);
    }
  });

  it('ONE LOOK PER STATE: what a figure is doing tells you its state, wherever it stands — every status, attention and posture', () => {
    const FLOOR = ['kneel', 'repair', 'tend'];
    const looks = new Map<string, Set<string>>();
    for (const status of CREW_STATUSES) for (const attention of [null, ...ATTENTION_ORDER]) for (const posture of WORK_POSTURES) {
      const anim = animationFor({ status, attention }, false, posture);
      const state = attention === 'stuck' ? 'stuck' : attention || status === 'waiting' ? 'needs you' : status;
      // On the floor with a tool = working. The three floor cycles are one look.
      const look = FLOOR.includes(anim) ? 'floor' : anim;
      looks.set(state, (looks.get(state) ?? new Set()).add(look));
    }
    expect(Object.fromEntries([...looks].map(([k, v]) => [k, [...v]]))).toEqual({
      working: ['floor'],       // down at its work
      idle: ['idle'],           // standing still
      'needs you': ['alert'],   // waving
      stuck: ['call'],          // calling out
    });
  });
});


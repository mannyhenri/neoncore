import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * A full-screen overlay opened from the Projects page must leave the page.
 *
 * The Projects page is drawn inside the bridge: a console panel, with the captain standing over
 * its left edge on his own layer (index.css `.projects-stage .stage-captain`, z-index 5) and the
 * picker's bar above it. A dialog rendered in place — `fixed inset-0 z-50` inside that panel — is
 * only "on top" within the panel: the captain, the bar and the top header are siblings that paint
 * over it. "Edit project" opened with parts of the dialog behind them.
 *
 * No z-index fixes that; the overlay has to leave the subtree (createPortal to document.body).
 * SET-BASED over everything the Projects page can render, not the one dialog that was reported:
 * the same wrapper carries New project, Edit feature, Move, Learnings, Scheduled runs, Run a
 * workflow and Draft the brief.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../components/ProjectsPage.tsx');

function subtree(entry: string, seen = new Set<string>()): string[] {
  if (seen.has(entry) || !existsSync(entry)) return [...seen];
  seen.add(entry);
  for (const m of readFileSync(entry, 'utf8').matchAll(/from\s+'(\.[^']+)'/g)) {
    const spec = m[1];
    if (spec.includes('/types') || spec.includes('/lib/') || spec.includes('/hooks/')) continue;
    for (const ext of ['.tsx', '.ts']) {
      const p = resolve(dirname(entry), spec + ext);
      if (existsSync(p)) { subtree(p, seen); break; }
    }
  }
  return [...seen];
}
const code = (file: string) => readFileSync(file, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
  .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));

const SUBTREE = subtree(ROOT);
const OVERLAYS = SUBTREE.flatMap((file) => {
  const src = code(file);
  return [...src.matchAll(/fixed inset-0/g)].map((m) => ({ file, src, index: m.index!, line: src.slice(0, m.index!).split('\n').length }));
});

describe('full-screen overlays opened from the Projects page', () => {
  it('the registry is non-empty and includes the dialog wrapper every project form uses', () => {
    expect(OVERLAYS.length).toBeGreaterThan(0);
    expect(OVERLAYS.some((o) => o.file.endsWith('ProjectParts.tsx')), 'the Modal in ProjectParts.tsx').toBe(true);
  });

  it.each(OVERLAYS.map((o) => ({ name: `${o.file.split('/').pop()}:${o.line}`, ...o })))('$name is portaled to document.body', ({ src, index }) => {
    const portal = src.indexOf('createPortal(');
    expect(portal, 'no createPortal in this file — the overlay is drawn inside the bridge panel, behind the captain and the bars').toBeGreaterThan(-1);
    expect(index, 'the overlay markup comes before every createPortal call, so it is not inside one').toBeGreaterThan(portal);
    expect(src, 'the portal target must be document.body').toMatch(/document\.body/);
  });
});

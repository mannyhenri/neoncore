/**
 * SETTINGS → THEMES — how NeonCore looks and sounds (server lib/custom-themes.ts).
 *
 * Every picture — the captain and his sets of animations, the crew, the maps, the props — and every
 * sound. Two themes are built in. Duplicate one, give it a name, and replace what you want; whatever
 * you do not replace stays as drawn. One theme is in use for everyone.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ThemesList, CustomThemeInfo } from '../types';
import { api } from '../lib/api';
import { packFor, MAPS_BY_THEME, themeFrom } from '../world/theme';
import { AssetBrowser, type PrepareImage, urlFor } from './AssetBrowser';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
export interface ThemeCardInfo { id: string; name: string; base: 'scifi' | 'fantasy'; builtIn: boolean; blurb: string; theme: CustomThemeInfo | null }

/** Who he is and where he works: the captain's first frame and the home map. */
function Preview({ card, active }: { card: ThemeCardInfo; active: string }) {
  const pack = packFor(card.base);
  const s = pack.decks.sheets.captain;
  const map = MAPS_BY_THEME[card.base][0].plate.src;
  const h = 150, w = s ? Math.round((h * s.frameW) / s.frameH) : 0;
  const rows = s ? Object.keys(s.rows).length : 1;
  const cols = s ? Math.max(...Object.values(s.rows).map((r) => r.frames)) : 1;
  return (
    <div className="flex items-stretch gap-3 shrink-0">
      {s && <div data-theme-captain aria-hidden="true" className="rounded-[10px] border border-white/[0.1] bg-[#0B1322] overflow-hidden" style={{ width: w * 0.62, height: h * 0.62 }}>
        <div style={{ width: w * 0.62, height: h * 0.62, backgroundImage: `url(${urlFor(card.theme, s.src, active)})`, backgroundSize: `${w * 0.62 * cols}px ${h * 0.62 * rows}px`, backgroundPosition: '0 0', imageRendering: 'pixelated' }} />
      </div>}
      <img data-theme-map src={urlFor(card.theme, map, active)} alt="" className="h-[93px] w-[170px] object-cover rounded-[10px] border border-white/[0.1]" />
    </div>
  );
}

export function ThemesSettings({ prepareImage, reload = () => window.location.reload() }: { prepareImage?: PrepareImage; reload?: () => void }) {
  const [list, setList] = useState<ThemesList | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [naming, setNaming] = useState<{ mode: 'duplicate' | 'rename'; id: string; name: string } | null>(null);
  const [browsing, setBrowsing] = useState<string | null>(null);
  const load = useCallback(() => Promise.resolve(api.getThemes()).then((l) => { setList(l); setError(''); }).catch((e) => setError(errText(e))), []);
  useEffect(() => { void load(); }, [load]);
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setError(''); try { await fn(); await load(); } catch (e) { setError(errText(e)); } finally { setBusy(false); } };
  if (!list) return <div className="px-4 py-4 md:px-6 text-[13px] text-gray-400">{error || 'Loading…'}</div>;

  const cards: ThemeCardInfo[] = [
    ...list.builtIn.map((t) => ({ id: t.id, name: t.name, base: themeFrom(t.id), builtIn: true, blurb: t.blurb, theme: null })),
    ...list.custom.map((t) => {
      const n = Object.keys(t.overrides).length;
      return { id: t.id, name: t.name, base: themeFrom(t.base), builtIn: false, blurb: `Based on ${list.builtIn.find((b) => b.id === t.base)?.name ?? t.base} · ${n} ${n === 1 ? 'picture or sound' : 'pictures and sounds'} replaced`, theme: t };
    }),
  ];
  const use = (c: ThemeCardInfo) => act(async () => { await api.setActiveTheme(c.id); reload(); });
  const shown = cards.find((c) => c.id === browsing) ?? null;
  const btn = 'h-10 px-4 rounded-[10px] border border-white/[0.16] text-[14px] font-semibold text-gray-100 hover:border-white/30 disabled:opacity-40';

  return (
    <div className="px-4 py-4 md:px-6 space-y-4" data-theme-settings>
      <div>
        <h3 className="font-display text-[20px] font-semibold text-gray-100">Themes</h3>
        <p className="text-[14px] text-gray-400 max-w-[760px] mt-1">How NeonCore looks and sounds: every picture — the captain and his sets of animations, the crew, the maps, the props — and every sound. Duplicate a theme, give it a name, and replace what you want; whatever you do not replace stays as drawn.</p>
      </div>
      {error && <p className="text-[13px] text-ember-300">{error}</p>}
      {cards.map((c) => {
        const active = list.active === c.id;
        return (
          <section key={c.id} data-theme-card={c.id} data-builtin={c.builtIn || undefined} data-active={active || undefined}
            className={`rounded-[16px] border px-5 py-4 flex items-center gap-5 flex-wrap ${active ? 'border-neon-500/60 bg-neon-500/[0.05]' : 'border-white/[0.12]'}`}>
            <Preview card={c} active={list.active} />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-display text-[20px] font-semibold text-white">{c.name}</span>
                {c.builtIn && <span data-badge="built-in" className="px-2.5 h-7 inline-flex items-center rounded-full bg-white/[0.06] text-[13px] text-gray-300">Built in</span>}
                {active && <span data-badge="in-use" className="px-2.5 h-7 inline-flex items-center rounded-full bg-emerald-500/15 text-[13px] text-emerald-300">In use for everyone</span>}
              </div>
              <p className="text-[14px] text-gray-400">{c.blurb}</p>
              {naming?.id === c.id ? (
                <form data-theme-naming className="flex items-center gap-2 flex-wrap" onSubmit={(e) => { e.preventDefault(); const n = naming; if (!n.name.trim()) return; setNaming(null);
                  void act(() => (n.mode === 'duplicate' ? api.createTheme({ name: n.name, from: c.id }) : api.renameTheme(c.id, n.name))); }}>
                  <input autoFocus value={naming.name} onChange={(e) => setNaming({ ...naming, name: e.target.value })} aria-label={naming.mode === 'duplicate' ? 'Name of the new theme' : 'New name'} className="glass-input h-10 px-3 rounded-[10px] text-[14px] w-[260px]" />
                  <button type="submit" disabled={busy || !naming.name.trim()} className="btn-primary h-10 px-4 rounded-[10px] text-[14px] font-semibold disabled:opacity-40">{naming.mode === 'duplicate' ? 'Create' : 'Rename'}</button>
                  <button type="button" onClick={() => setNaming(null)} className="btn-ghost h-10 px-3 rounded-[10px] text-[14px]">Cancel</button>
                </form>
              ) : (
                <div className="flex items-center gap-2 flex-wrap">
                  <button data-theme-browse onClick={() => setBrowsing(c.id)} className={btn}>{c.builtIn ? 'Browse its assets' : 'Edit its pictures and sounds'}</button>
                  <button data-theme-duplicate disabled={busy} onClick={() => setNaming({ mode: 'duplicate', id: c.id, name: `${c.name} copy` })} className={btn}>Duplicate</button>
                  {!active && <button data-theme-use disabled={busy} onClick={() => void use(c)} className={btn}>Use for everyone</button>}
                  {!c.builtIn && <button data-theme-rename disabled={busy} onClick={() => setNaming({ mode: 'rename', id: c.id, name: c.name })} className={btn}>Rename</button>}
                  {!c.builtIn && <button data-theme-delete disabled={busy} onClick={() => { if (confirm(`Delete the theme "${c.name}" and every picture and sound in it?${active ? ' The theme it is based on is used again.' : ''}`)) void act(async () => { await api.deleteTheme(c.id); if (active) reload(); }); }}
                    className="h-10 px-4 rounded-[10px] border border-red-400/45 text-[14px] font-semibold text-red-200 hover:bg-red-500/10">Delete</button>}
                </div>
              )}
            </div>
          </section>
        );
      })}
      <p className="text-[13px] text-gray-400 border-l-2 border-white/10 pl-3 max-w-[760px]">
        A replacement keeps the original&apos;s shape: a sprite sheet keeps its grid of frames, a map its proportions (everything on it is placed by fractions of it). It may be drawn larger or smaller. The theme editor cuts, trims and fits art of other proportions for you, and can make a plain background see-through.
      </p>
      {shown && <AssetBrowser card={shown} active={list.active} prepareImage={prepareImage} onClose={() => setBrowsing(null)}
        onChanged={async () => { await load(); if (list.active === shown.id) reload(); }} />}
    </div>
  );
}

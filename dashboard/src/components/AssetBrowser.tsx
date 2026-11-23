/**
 * A THEME'S PICTURES AND SOUNDS — browse (and, in a theme of your own, replace) every one, grouped
 * (lib/themeCatalog.ts). A picture is fitted to the shape it replaces before it is kept
 * (lib/fitImage.ts): you see the result first, and can make a plain background see-through.
 */
import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CustomThemeInfo } from '../types';
import { api } from '../lib/api';
import { assetsFor, groupsOf, type ThemeAsset } from '../lib/themeCatalog';
import { fitPicture, loadImage, pixelsOf, pngOf } from '../lib/fitImage';
import type { ThemeCardInfo } from './ThemesSettings';

/** Fit a picture to an asset's shape: a PNG data URL of exactly `size`. Swappable (tests have no canvas). */
export type PrepareImage = (file: File, asset: ThemeAsset, size: { w: number; h: number }, seeThrough: boolean) => Promise<string>;
export const canvasPrepare: PrepareImage = async (file, asset, size, seeThrough) => {
  const url = URL.createObjectURL(file);
  try {
    const im = await loadImage(url);
    return pngOf(fitPicture(pixelsOf(im), { fit: asset.fit === 'sound' ? 'contain' : asset.fit, grid: asset.grid }, size.w, size.h, seeThrough));
  } finally { URL.revokeObjectURL(url); }
};
const base64Of = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
  r.onerror = () => reject(new Error('that file could not be read'));
  r.readAsDataURL(file);
});

/** Where to see an asset of a theme: its replacement when it has one, else the original. */
export function urlFor(theme: CustomThemeInfo | null, path: string, active: string): string {
  const o = theme?.overrides[path];
  if (!theme || !o) return path;
  return theme.id === active ? `${path}?v=${encodeURIComponent(o.at)}` : `/api/themes/${theme.id}/files?path=${encodeURIComponent(path)}&v=${encodeURIComponent(o.at)}`;
}

function Sets({ asset, src }: { asset: ThemeAsset; src: string }) {
  const g = asset.grid!;
  const h = 96;
  return (
    <ul data-asset-sets className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-2">
      {g.sets.map((name, row) => (
        <li key={name} data-asset-set={name} className="rounded-[8px] border border-white/[0.08] bg-[#0B1322] p-1.5 flex flex-col items-center">
          <div className="overflow-hidden" style={{ width: g.frameW && g.frameH ? (h * g.frameW) / g.frameH : h, height: h }}>
            <div className="world-strip" style={{
              width: `${g.cols * 100}%`, height: '100%', backgroundImage: `url(${src})`, backgroundRepeat: 'no-repeat',
              backgroundSize: `100% ${g.rows * 100}%`, backgroundPosition: `0 ${g.rows > 1 ? (row / (g.rows - 1)) * 100 : 0}%`,
              animationDuration: `${g.cols / 4}s`, animationTimingFunction: `steps(${g.cols})`, imageRendering: 'pixelated',
            }} />
          </div>
          <span className="text-[11px] text-gray-400 mt-1">{name}</span>
        </li>
      ))}
    </ul>
  );
}

function AssetCard({ asset, card, active, prepare, onChanged }: { asset: ThemeAsset; card: ThemeCardInfo; active: string; prepare: PrepareImage; onChanged: () => void }) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [sets, setSets] = useState(false);
  const [pending, setPending] = useState<{ file: File; seeThrough: boolean; preview: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const src = urlFor(card.theme, asset.path, active);
  const replaced = !!card.theme?.overrides[asset.path];
  const mine = card.builtIn ? null : card.theme;
  const g = asset.grid;
  const frame = g && size ? { w: Math.round(size.w / g.cols), h: Math.round(size.h / g.rows) } : null;
  const fitTo = async (file: File, seeThrough: boolean) => {
    if (!size) throw new Error('the original is still loading — try again in a moment');
    return prepare(file, asset, size, seeThrough);
  };
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(''); try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  const choose = (file: File | undefined) => { if (!file || !mine) return; void run(async () => {
    if (asset.kind === 'sound') { await api.setThemeAsset(mine.id, asset.path, await base64Of(file)); onChanged(); return; }
    const seeThrough = asset.fit !== 'cover';
    setPending({ file, seeThrough, preview: await fitTo(file, seeThrough) });
  }); };

  return (
    <article data-asset={asset.path} data-replaced={replaced || undefined} className="rounded-[16px] border border-white/[0.1] bg-[rgba(8,14,30,0.8)] p-4 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="text-[16px] font-semibold text-white">{asset.title}</h4>
          <p className="font-mono text-[12px] text-gray-400 truncate">{asset.path}</p>
        </div>
        {replaced && <span data-badge="replaced" className="shrink-0 px-2 h-6 inline-flex items-center rounded-full bg-violet-500/15 text-[12px] text-violet-200">Replaced</span>}
      </div>
      <div className="rounded-[10px] border border-white/[0.08] flex items-center justify-center min-h-[140px] p-2"
        style={{ backgroundColor: '#141a26', backgroundImage: 'linear-gradient(45deg,#1c2433 25%,transparent 25%,transparent 75%,#1c2433 75%),linear-gradient(45deg,#1c2433 25%,transparent 25%,transparent 75%,#1c2433 75%)', backgroundSize: '16px 16px', backgroundPosition: '0 0,8px 8px' }}>
        {asset.kind === 'sound'
          ? <audio data-asset-audio controls src={src} className="w-full" />
          : <img data-asset-image src={pending?.preview ?? src} alt="" className="max-h-[220px] max-w-full object-contain" style={{ imageRendering: 'pixelated' }}
              onLoad={(e) => { if (!pending) setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight }); }} />}
      </div>
      {asset.kind === 'image' && (
        <p data-asset-size className="font-mono text-[13px] text-gray-300">{size ? `${size.w} × ${size.h}` : '…'}{g ? ` · ${g.cols} × ${g.rows} frames${frame ? ` of ${frame.w} × ${frame.h}` : ''}` : ''}</p>
      )}
      <p className="text-[13px] text-gray-400">{asset.note}</p>
      {pending ? (
        <div data-asset-pending className="space-y-2 rounded-[10px] border border-violet-400/40 bg-violet-500/[0.06] p-3">
          <p className="text-[13px] text-gray-200">Fitted to {size ? `${size.w} × ${size.h}` : 'the original'}{g ? `, cut into its ${g.cols} × ${g.rows} frames and trimmed` : ''}. Keep it?</p>
          <label className="flex items-center gap-2 text-[13px] text-gray-200">
            <input type="checkbox" checked={pending.seeThrough} disabled={busy} className="accent-violet-500"
              onChange={(e) => { const on = e.target.checked; void run(async () => setPending({ ...pending, seeThrough: on, preview: await fitTo(pending.file, on) })); }} />
            Make a plain background see-through
          </label>
          <div className="flex gap-2">
            <button data-asset-keep disabled={busy} onClick={() => void run(async () => { await api.setThemeAsset(mine!.id, asset.path, pending.preview.replace(/^data:[^,]*,/, '')); setPending(null); onChanged(); })} className="btn-primary h-9 px-4 rounded-[9px] text-[13px] font-semibold">Use this</button>
            <button disabled={busy} onClick={() => setPending(null)} className="btn-ghost h-9 px-3 rounded-[9px] text-[13px]">Cancel</button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-wrap mt-auto">
          <a data-asset-download href={src} download={asset.path.split('/').pop()} className="h-9 px-4 rounded-[9px] border border-white/[0.16] text-[13px] font-semibold text-gray-100 inline-flex items-center">Download</a>
          {g && g.rows > 0 && g.sets.length > 0 && <button data-asset-show-sets aria-expanded={sets} onClick={() => setSets((v) => !v)} className="h-9 px-4 rounded-[9px] border border-white/[0.16] text-[13px] font-semibold text-gray-100 ml-auto">{sets ? 'Hide the sets' : `Show the ${g.sets.length} ${g.sets.length === 1 ? 'set' : 'sets'}`}</button>}
          {mine && (
            <label className="h-9 px-4 rounded-[9px] bg-violet-500/20 border border-violet-400/50 text-[13px] font-semibold text-violet-100 inline-flex items-center cursor-pointer">
              Replace…
              <input data-asset-file type="file" className="sr-only" accept={asset.kind === 'sound' ? 'audio/mpeg,audio/wav,audio/ogg,.mp3,.wav,.ogg' : 'image/png,image/jpeg,image/gif,image/webp'} disabled={busy}
                onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
          )}
          {mine && replaced && <button data-asset-revert disabled={busy} onClick={() => void run(async () => { await api.revertThemeAsset(mine.id, asset.path); onChanged(); })} className="h-9 px-3 rounded-[9px] text-[13px] text-gray-300 hover:text-white">Revert to the original</button>}
        </div>
      )}
      {sets && g && <Sets asset={asset} src={src} />}
      {error && <p data-asset-error className="text-[13px] text-ember-300">{error}</p>}
    </article>
  );
}

export function AssetBrowser({ card, active, onClose, onChanged, prepareImage = canvasPrepare }: { card: ThemeCardInfo; active: string; onClose: () => void; onChanged: () => void; prepareImage?: PrepareImage }) {
  const groups = useMemo(() => groupsOf(assetsFor(card.base)), [card.base]);
  const [group, setGroup] = useState(groups[0]?.group);
  const shown = groups.find((g) => g.group === group) ?? groups[0];
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div data-asset-browser role="dialog" aria-label={`${card.name} — pictures and sounds`} className="fixed inset-0 z-50 flex flex-col bg-[#070B16]/97 backdrop-blur-sm" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <header className="flex items-start justify-between gap-4 px-6 py-4 border-b border-white/[0.1]">
        <div>
          <h3 className="font-display text-[22px] font-semibold text-white">{card.name} <span className="text-gray-400 font-normal">— pictures and sounds</span></h3>
          <p className="text-[14px] text-gray-400">{card.builtIn ? 'Built in: browse and download its art. Duplicate it in Settings → Themes to change anything.' : 'Yours: replace any picture or sound — what you do not replace stays as drawn.'}</p>
        </div>
        <button data-asset-close onClick={onClose} className="h-10 px-4 rounded-[10px] border border-white/[0.16] font-display text-[13px] font-bold tracking-[0.14em] uppercase text-gray-100">× Close</button>
      </header>
      <div className="flex-1 min-h-0 flex">
        <nav aria-label="Groups" className="w-[260px] shrink-0 overflow-y-auto border-r border-white/[0.08] p-3 space-y-1">
          {groups.map((g) => (
            <button key={g.group} data-asset-group={g.group} aria-pressed={g.group === shown?.group} onClick={() => setGroup(g.group)}
              className={`w-full flex items-center justify-between h-11 px-4 rounded-[10px] font-mono text-[14px] ${g.group === shown?.group ? 'bg-white/[0.08] text-white' : 'text-gray-300 hover:bg-white/[0.04]'}`}>
              {g.group}<span className="text-gray-500 tabular-nums">{g.assets.length}</span>
            </button>
          ))}
        </nav>
        <div className="flex-1 min-w-0 overflow-y-auto p-5">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {shown?.assets.map((a) => <AssetCard key={a.path} asset={a} card={card} active={active} prepare={prepareImage} onChanged={onChanged} />)}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * THE PROJECT'S DESIGN SYSTEM — STEP 1: ITS DIRECTION.
 *
 *   1  Load pictures of interfaces you like (the inspiration).
 *   2  Claude's /design, run in the project's main repo, answers with FOUR directions on a canvas.
 *   3  Comment on any of them, ask for "more like this one", and get four more — as often as you like.
 *   4  Select the one you want. That is the project's direction, and step 1 is done.
 *
 * Everything is kept with the project (lib/design/store.ts): the pictures, every round, every
 * comment and the selection — so the exploration can be picked up again, and step 2 starts from it.
 *
 * THE DESIGNER IS CLAUDE'S /design, in the project's main repo (server lib/design-request.ts). The
 * page asks for a round, waits, and shows the four directions when Claude submits them — with the
 * link to the canvas it published. The page designs nothing: with no Claude cartridge on the main
 * repo it says so, and there is no round.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesignExploration, DesignInspiration, DesignRound, DesignVariation, Project } from '../types';
import { extractColors, VARIATIONS_PER_ROUND } from '../lib/design/designer';
import { EMPTY_EXPLORATION, loadExploration, saveExploration, finalizeExploration, publishExploration, requestRound, cancelRound, missingRoute, type Kept, type ServerPart } from '../lib/design/store';
import { DesignSystemFinal } from './DesignSystemFinal';
import { DesignPreview } from './DesignPreview';

export const MAX_INSPIRATIONS = 8;
const PICTURE_EDGE = 720;
const uid = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const sameDirection = (a?: { roundId: string; variationId: string } | null, b?: { roundId: string; variationId: string } | null) => !!a && !!b && a.roundId === b.roundId && a.variationId === b.variationId;
const repoName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const errText = (e: unknown) => (e instanceof Error ? e.message : 'That did not work');

/** A picture file → a scaled-down JPEG and the colours in it. In the browser only (it draws on a canvas). */
export async function readPicture(file: File): Promise<DesignInspiration> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error(`${file.name} is not a picture this browser can read`)); i.src = url; });
    const scale = Math.min(1, PICTURE_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser cannot read pictures');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    // Colours from a small copy: enough to know the palette, quick on any picture.
    const small = document.createElement('canvas');
    small.width = 64; small.height = Math.max(1, Math.round((64 * canvas.height) / canvas.width));
    small.getContext('2d')!.drawImage(canvas, 0, 0, small.width, small.height);
    const colors = extractColors(small.getContext('2d')!.getImageData(0, 0, small.width, small.height).data);
    return { id: uid(), name: file.name, dataUrl: canvas.toDataURL('image/jpeg', 0.82), colors };
  } finally { URL.revokeObjectURL(url); }
}

const btn = 'h-9 px-3.5 rounded-[10px] text-[13px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
const stepLabel = 'text-[11px] font-bold tracking-[0.14em] uppercase text-neon-300';

export function DesignSystemTab({ project, read = readPicture, pollMs = 3000 }: {
  project: Project;
  /** How a picture file is read (tests give their own: jsdom has no canvas). */
  read?: (file: File) => Promise<DesignInspiration>;
  /** How often the page asks how the round being designed is going. */
  pollMs?: number;
}) {
  const [data, setData] = useState<DesignExploration | null>(null);
  const [kept, setKept] = useState<Kept>('server');
  const [error, setError] = useState('');
  /** The request to the designer is on its way to the server. */
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  /** "More like this one": the variation the next round explores. */
  const [base, setBase] = useState<{ roundId: string; variationId: string } | null>(null);
  const [showAll, setShowAll] = useState(false);
  /** Step 2: what the server is doing right now, and whether it has step 2 at all. */
  const [working, setWorking] = useState<'' | 'finalizing' | 'publishing'>('');
  const [needsServer, setNeedsServer] = useState(false);
  const dataRef = useRef<DesignExploration>(EMPTY_EXPLORATION);
  const keptRef = useRef<Kept>('server');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    setData(null); setError(''); setBase(null); setNote('');
    setWorking(''); setNeedsServer(false);
    loadExploration(project.id).then((r) => {
      if (!alive) return;
      dataRef.current = r.data; keptRef.current = r.kept; setData(r.data); setKept(r.kept);
      // A direction selected before the system existed (or changed since): finalize it now.
      if (r.kept === 'server' && r.data.selected && !sameDirection(r.data.selected, r.data.system?.from)) void finalizeRef.current();
    })
      .catch((e) => { if (alive) { setError(errText(e)); setData({ ...EMPTY_EXPLORATION }); } });
    return () => { alive = false; };
  }, [project.id]);

  /** Change the exploration: shown at once, then kept. A save that fails is said, and what is on screen stays. */
  const update = useCallback(async (change: (d: DesignExploration) => DesignExploration) => {
    const next = change(dataRef.current);
    dataRef.current = next;
    setData(next);
    try {
      const saved = await saveExploration(project.id, next, keptRef.current);
      keptRef.current = saved.kept; setKept(saved.kept); setError('');
      return true;
    } catch (e) { setError(`Not saved: ${errText(e)}`); return false; }
  }, [project.id]);

  /** Step 2 comes back from the server: its part replaces what is on screen; the exploration stays. */
  const takeServerPart = useCallback((part: ServerPart) => {
    dataRef.current = { ...dataRef.current, ...part };
    setData(dataRef.current);
  }, []);
  /** The selected direction → the whole system. Done by the server; nothing is committed anywhere. */
  const finalizeNow = useCallback(async () => {
    if (keptRef.current !== 'server') return;
    const id = project.id;
    setWorking('finalizing');
    try {
      const part = await finalizeExploration(id);
      if (id === projectRef.current) takeServerPart(part);
    } catch (e) {
      if (id !== projectRef.current) return;
      if (missingRoute(e)) setNeedsServer(true); else setError(`Not finalized: ${errText(e)}`);
    } finally { if (id === projectRef.current) setWorking(''); }
  }, [project.id, takeServerPart]);
  const finalizeRef = useRef(finalizeNow);
  finalizeRef.current = finalizeNow;
  const projectRef = useRef(project.id);
  projectRef.current = project.id;
  /** The whole page as the server has it now (a round arrived, a request changed). */
  const takeWhole = useCallback((whole: DesignExploration) => {
    dataRef.current = { ...EMPTY_EXPLORATION, ...whole };
    setData(dataRef.current);
  }, []);
  // While a round is being designed, ask how it is going — it arrives when Claude submits it.
  const waiting = data?.designing?.status === 'pending' && kept === 'server';
  useEffect(() => {
    if (!waiting) return;
    const id = project.id;
    const t = setInterval(() => {
      loadExploration(id).then((r) => { if (id === projectRef.current && r.kept === 'server') takeWhole(r.data); }).catch(() => { /* asked again next time */ });
    }, pollMs);
    return () => clearInterval(t);
  }, [waiting, project.id, pollMs, takeWhole]);
  /** Selecting a direction keeps it, then finalizes it. */
  const select = useCallback(async (sel: { roundId: string; variationId: string }) => {
    if (await update((d) => ({ ...d, selected: sel }))) await finalizeNow();
  }, [update, finalizeNow]);
  /** The system → every repo of the project: written, committed, pushed. Only ever from the button. */
  const publish = useCallback(async () => {
    const id = project.id;
    setWorking('publishing'); setError('');
    try {
      const part = await publishExploration(id);
      if (id === projectRef.current) takeServerPart(part);
    } catch (e) { if (id === projectRef.current) setError(`Not published: ${errText(e)}`); }
    finally { if (id === projectRef.current) setWorking(''); }
  }, [project.id, takeServerPart]);

  const addPictures = async (files: FileList | File[] | null) => {
    const list = [...(files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (list.length === 0) return;
    const room = MAX_INSPIRATIONS - dataRef.current.inspirations.length;
    if (room <= 0) { setError(`${MAX_INSPIRATIONS} pictures is the most. Remove one to add another.`); return; }
    try {
      const pictures = await Promise.all(list.slice(0, room).map((f) => read(f)));
      await update((d) => ({ ...d, inspirations: [...d.inspirations, ...pictures] }));
      if (list.length > room) setError(`Added ${room}; ${MAX_INSPIRATIONS} pictures is the most.`);
    } catch (e) { setError(errText(e)); }
  };

  if (!data) return <p className="text-[13px] text-gray-500">Loading…</p>;

  const latest = data.rounds[data.rounds.length - 1] ?? null;
  const find = (sel: { roundId: string; variationId: string } | null) => {
    const round = sel ? data.rounds.find((r) => r.id === sel.roundId) : undefined;
    const variation = round?.variations.find((v) => v.id === sel!.variationId);
    return round && variation ? { round, variation } : null;
  };
  const chosen = find(data.selected);
  const baseOf = find(base);
  const roundNo = (r: DesignRound) => data.rounds.indexOf(r) + 1;
  // What the designer is told next: the note, and every comment made on the round in front of you.
  const comments = latest ? latest.variations.flatMap((v) => v.comments.map((c) => ({ on: v.name, text: c.text }))) : [];

  // The designer is Claude's /design, in the project's main repo. A round is asked for; it arrives when Claude submits it.
  const request = data.designing ?? null;
  const designing = asking || request?.status === 'pending';
  const designer = data.designer;
  const canDesign = kept === 'server' && !!designer?.ok && data.inspirations.length > 0 && !designing;
  const design = async () => {
    if (!canDesign) return;
    setAsking(true); setError('');
    try {
      takeWhole(await requestRound(project.id, { note: note.trim(), basedOn: base }));
      setNote(''); setBase(null);
    } catch (e) { setError(`Not sent to the designer: ${errText(e)}`); } finally { setAsking(false); }
  };
  const stopWaiting = async () => { try { takeWhole(await cancelRound(project.id)); } catch (e) { setError(errText(e)); } };
  const comment = (roundId: string, variationId: string, text: string) => update((d) => ({
    ...d, rounds: d.rounds.map((r) => (r.id !== roundId ? r : { ...r, variations: r.variations.map((v) => (v.id !== variationId ? v : { ...v, comments: [...v.comments, { id: uid(), text, at: new Date().toISOString() }] })) })),
  }));
  const uncomment = (roundId: string, variationId: string, commentId: string) => update((d) => ({
    ...d, rounds: d.rounds.map((r) => (r.id !== roundId ? r : { ...r, variations: r.variations.map((v) => (v.id !== variationId ? v : { ...v, comments: v.comments.filter((c) => c.id !== commentId) })) })),
  }));

  return (
    <div data-design-system className="space-y-6">
      {/* what this is, and who the designer is */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <p className={stepLabel}>Design system</p>
          <h3 className="font-display text-[22px] font-semibold text-gray-100 mt-1">Find the direction</h3>
          <p className="text-[14px] text-gray-400 mt-1 max-w-[760px] leading-relaxed">
            Load pictures of interfaces you like. Claude answers with four different directions; comment, ask for more, and select the one {project.name} should be built in.
          </p>
        </div>
        <div data-designer data-ok={designer?.ok ? 'yes' : 'no'} className={`max-w-[420px] rounded-[12px] border px-3.5 py-2.5 ${designer?.ok ? 'border-neon-500/40 bg-neon-600/[0.06]' : 'border-amber-400/40 bg-amber-400/[0.06]'}`}>
          <p className={`text-[12px] font-bold tracking-[0.1em] uppercase ${designer?.ok ? 'text-neon-300' : 'text-amber-300'}`}>Designer · Claude /design</p>
          <p className="text-[12px] text-gray-300 leading-snug mt-0.5">
            {kept === 'browser' ? 'Claude designs through the server, and this server does not have the design system yet. Rebuild and restart it.'
              : designer?.ok ? <>Runs in the project’s main repo, on <span className="text-gray-100 font-semibold">{designer.agentName}</span> <span className="text-gray-500" title={designer.repoPath}>({repoName(designer.repoPath)})</span>. It reads your pictures and the repo, and publishes a canvas of four artboards.</>
                : designer?.error ?? 'Looking for the Claude cartridge on the project’s main repo…'}
          </p>
        </div>
      </div>
      {error && <p role="alert" className="text-[13px] text-ember-300">{error}</p>}
      {request?.status === 'pending' && (
        <div data-designing data-queued={request.queued ? 'yes' : 'no'} className="rounded-[12px] border border-neon-500/40 bg-neon-600/[0.06] px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
          <p className="text-[14px] text-gray-100">
            {request.queued
              ? <>Waiting for <span className="font-semibold">{request.agentName || 'the cartridge'}</span> to finish what it is doing — the request is sent as soon as it is free.</>
              : <>Claude is designing four directions in <span className="font-semibold">{request.agentName || 'the main repo'}</span>… they appear here when it submits them.</>}
          </p>
          <button data-cancel-design onClick={() => void stopWaiting()} className={`${btn} btn-ghost`}>Stop waiting</button>
        </div>
      )}
      {request?.status === 'failed' && request.error && request.error !== 'Cancelled' && (
        <p data-design-failed className="rounded-[12px] border border-ember-400/40 bg-ember-500/[0.06] px-4 py-3 text-[13px] text-ember-200">The last round did not arrive: {request.error}</p>
      )}
      {kept === 'browser' && (
        <p data-kept-in-browser className="text-[12px] text-gray-400">Kept in this browser for now: this server does not have the design system yet. Rebuild and restart it to keep it with the project.</p>
      )}

      {/* the direction chosen */}
      {chosen && (
        <section data-selected-direction className="rounded-[16px] border border-emerald-400/50 bg-emerald-400/[0.05] p-5 grid grid-cols-1 lg:grid-cols-[minmax(0,420px)_1fr] gap-5 items-center">
          <DesignPreview tokens={chosen.variation.tokens} compact />
          <div>
            <p className="text-[11px] font-bold tracking-[0.14em] uppercase text-emerald-300">Selected direction · step 1 done</p>
            <p className="text-[22px] font-semibold text-gray-100 mt-1">{chosen.variation.name}</p>
            <p className="text-[14px] text-gray-300 mt-1.5 leading-relaxed max-w-[640px]">{chosen.variation.rationale}</p>
            <TokenFacts v={chosen.variation} />
            <div className="flex items-center gap-3 mt-4 flex-wrap">
              <button data-unselect onClick={() => update((d) => ({ ...d, selected: null }))} className={`${btn} btn-ghost`}>Change my mind</button>
              <span className="text-[13px] text-gray-400">The system below is built from this direction. You can still keep exploring; selecting another makes the next version.</span>
            </div>
          </div>
        </section>
      )}

      {/* step 2 · the system made from it, and the repos it goes to */}
      <DesignSystemFinal projectName={project.name} system={data.system ?? null} published={data.published ?? null} repos={data.repos ?? []}
        pending={!!chosen} needsServer={!!chosen && (needsServer || kept === 'browser')} working={working} onPublish={publish} />

      {/* 1 · inspiration */}
      <section data-inspiration className="rounded-[16px] border border-white/[0.1] bg-gl-surface/40 p-5">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p className={stepLabel}>1 · Inspiration</p>
            <p className="text-[13px] text-gray-400 mt-0.5">Screenshots of products, dribbble shots, a brand page — anything whose look you want. Up to {MAX_INSPIRATIONS}.</p>
          </div>
          <button onClick={() => input.current?.click()} disabled={data.inspirations.length >= MAX_INSPIRATIONS} className={`${btn} btn-ghost`}>+ Add pictures</button>
          <input ref={input} type="file" accept="image/*" multiple hidden aria-label="Inspiration pictures" onChange={(e) => { void addPictures(e.target.files); e.target.value = ''; }} />
        </div>
        <div data-drop onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void addPictures(e.dataTransfer.files); }}
          className={`mt-4 rounded-[12px] border border-dashed ${data.inspirations.length ? 'border-white/[0.12] p-3' : 'border-neon-500/50 p-8 text-center'}`}>
          {data.inspirations.length === 0 ? (
            <>
              <p className="text-[15px] text-gray-200">Drop pictures here</p>
              <p className="text-[13px] text-gray-500 mt-1">or use “+ Add pictures”. Claude reads them, and the project’s main repo.</p>
            </>
          ) : (
            <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
              {data.inspirations.map((p) => (
                <li key={p.id} data-picture={p.id} className="relative group rounded-[10px] overflow-hidden border border-white/[0.12] bg-black/30">
                  <img src={p.dataUrl} alt={p.name} className="w-full h-[110px] object-cover" />
                  <div className="flex items-center gap-1 px-2 py-1.5">
                    {p.colors.slice(0, 6).map((c) => <span key={c} title={c} className="w-3.5 h-3.5 rounded-full border border-white/20" style={{ background: c }} />)}
                    <span className="ml-auto text-[11px] text-gray-500 truncate max-w-[50%]" title={p.name}>{p.name}</span>
                  </div>
                  <button onClick={() => update((d) => ({ ...d, inspirations: d.inspirations.filter((x) => x.id !== p.id) }))} aria-label={`Remove ${p.name}`}
                    className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-black/70 text-gray-200 text-[13px] opacity-0 group-hover:opacity-100 focus:opacity-100">×</button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {data.rounds.length === 0 && (
          <div className="mt-4 flex items-center gap-3 flex-wrap">
            <button data-design onClick={design} disabled={!canDesign} className={`${btn} btn-primary h-11 px-5 text-[14px]`}>
              {designing ? 'Designing…' : `✦ Design ${VARIATIONS_PER_ROUND} directions`}
            </button>
            {data.inspirations.length === 0 && <span className="text-[13px] text-gray-500">Add at least one picture first.</span>}
          </div>
        )}
      </section>

      {/* 2 · the directions */}
      {latest && (
        <section data-round={latest.id} className="space-y-4">
          <div>
            <p className={stepLabel}>2 · Directions — round {data.rounds.length}</p>
            <p className="text-[13px] text-gray-400 mt-0.5">
              {latest.basedOn ? `Four takes on “${find(latest.basedOn)?.variation.name ?? 'an earlier direction'}”.` : 'Four different directions from your pictures and the repo.'}
              {latest.by && <> Designed by <span className="text-gray-200">{latest.by}</span> with /design.</>}
              {latest.canvasUrl && <> <a data-canvas-link href={latest.canvasUrl} target="_blank" rel="noreferrer" className="text-neon-300 hover:text-white font-semibold">Open the canvas ↗</a></>}
              {latest.brief && <> You asked: <span className="text-gray-200">“{latest.brief}”</span></>}
            </p>
          </div>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            {latest.variations.map((v, i) => (
              <VariationCard key={v.id} n={i + 1} v={v}
                selected={data.selected?.roundId === latest.id && data.selected.variationId === v.id}
                isBase={base?.roundId === latest.id && base.variationId === v.id}
                onSelect={() => select({ roundId: latest.id, variationId: v.id })}
                onBase={() => setBase((b) => (b?.roundId === latest.id && b.variationId === v.id ? null : { roundId: latest.id, variationId: v.id }))}
                onComment={(text) => comment(latest.id, v.id, text)} onUncomment={(id) => uncomment(latest.id, v.id, id)} />
            ))}
          </div>

          {/* 3 · keep going */}
          <div data-keep-designing className="rounded-[16px] border border-neon-500/40 bg-neon-600/[0.05] p-5">
            <p className={stepLabel}>3 · Keep designing</p>
            <p className="text-[13px] text-gray-400 mt-0.5">
              {baseOf ? <>The next round explores <span className="text-gray-100 font-semibold">“{baseOf.variation.name}”</span> further. </> : 'The next round is four new directions. Pick “More like this” on a card to explore one instead. '}
              {comments.length > 0 && `Your ${comments.length} comment${comments.length === 1 ? '' : 's'} above ${comments.length === 1 ? 'is' : 'are'} taken into account.`}
            </p>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} aria-label="What should change in the next round"
              placeholder="What should change? e.g. “darker, rounder corners, a serif for headings, calmer colour, more space”"
              className="glass-input w-full mt-3 rounded-[10px] px-3 py-2 text-[14px] text-gray-100" />
            <div className="flex items-center gap-3 mt-3 flex-wrap">
              <button data-design onClick={design} disabled={!canDesign} className={`${btn} btn-primary h-11 px-5 text-[14px]`}>{designing ? 'Designing…' : `✦ Design ${VARIATIONS_PER_ROUND} more`}</button>
              {(note.trim() || comments.length > 0 || baseOf) && <span data-brief className="text-[13px] text-gray-300">Claude is told: {[note.trim() && 'your note', comments.length > 0 && `${comments.length} comment${comments.length === 1 ? '' : 's'}`, baseOf && `more like “${baseOf.variation.name}”`].filter(Boolean).join(' · ')}</span>}
            </div>
          </div>
        </section>
      )}

      {/* earlier rounds */}
      {data.rounds.length > 1 && (
        <section data-earlier>
          <button onClick={() => setShowAll((v) => !v)} aria-expanded={showAll} className="text-[13px] font-semibold text-neon-300 hover:text-white">
            {showAll ? '▾' : '▸'} Earlier rounds ({data.rounds.length - 1})
          </button>
          {showAll && (
            <div className="mt-3 space-y-5">
              {data.rounds.slice(0, -1).reverse().map((r) => (
                <div key={r.id} data-round={r.id}>
                  <p className="text-[12px] text-gray-400 mb-2">Round {roundNo(r)}{r.brief ? ` — “${r.brief}”` : ''}</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
                    {r.variations.map((v) => {
                      const on = data.selected?.roundId === r.id && data.selected.variationId === v.id;
                      return (
                        <div key={v.id} data-variation={v.id} data-selected={on || undefined} className={`rounded-[12px] border p-2.5 ${on ? 'border-emerald-400/70' : 'border-white/[0.1]'}`}>
                          <DesignPreview tokens={v.tokens} compact />
                          <div className="flex items-center gap-2 mt-2">
                            <span className="text-[13px] font-semibold text-gray-100 truncate flex-1">{v.name}</span>
                            <button onClick={() => select({ roundId: r.id, variationId: v.id })} disabled={on} className="text-[12px] font-semibold text-emerald-300 hover:text-white disabled:text-gray-500">{on ? 'Selected' : 'Select'}</button>
                            <button onClick={() => { setBase({ roundId: r.id, variationId: v.id }); }} className="text-[12px] font-semibold text-neon-300 hover:text-white">More like this</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function TokenFacts({ v }: { v: DesignVariation }) {
  const t = v.tokens;
  return (
    <div data-token-facts className="flex items-center gap-x-4 gap-y-1.5 flex-wrap mt-3 text-[12px] text-gray-400">
      <span className="inline-flex items-center gap-1">
        {(['primary', 'accent', 'bg', 'surface', 'text'] as const).map((k) => <span key={k} title={`${k} ${t.colors[k]}`} className="w-4 h-4 rounded-full border border-white/25" style={{ background: t.colors[k] }} />)}
      </span>
      <span><span className="text-gray-200">{t.fontHeading}</span>{t.fontBody !== t.fontHeading && <> + <span className="text-gray-200">{t.fontBody}</span></>}</span>
      <span>{t.dark ? 'Dark' : 'Light'}</span>
      <span>{t.radius === 0 ? 'Square corners' : `${t.radius}px corners`}</span>
      <span className="capitalize">{t.density}</span>
      <span className="capitalize">{t.surface} surfaces</span>
    </div>
  );
}

function VariationCard({ n, v, selected, isBase, onSelect, onBase, onComment, onUncomment }: {
  n: number; v: DesignVariation; selected: boolean; isBase: boolean;
  onSelect: () => void; onBase: () => void; onComment: (text: string) => void; onUncomment: (id: string) => void;
}) {
  const [text, setText] = useState('');
  return (
    <article data-variation={v.id} data-selected={selected || undefined} data-base={isBase || undefined}
      className={`rounded-[16px] border p-4 flex flex-col gap-3 ${selected ? 'border-emerald-400/70 bg-emerald-400/[0.04]' : isBase ? 'border-neon-400 bg-neon-600/[0.06]' : 'border-white/[0.1] bg-gl-surface/40'}`}>
      <DesignPreview tokens={v.tokens} />
      <div>
        <p className="text-[17px] font-semibold text-gray-100"><span className="text-gray-500 mr-2">{n}</span><span data-variation-name>{v.name}</span></p>
        <p className="text-[13px] text-gray-300 mt-1 leading-relaxed">{v.rationale}</p>
        <TokenFacts v={v} />
      </div>
      {v.comments.length > 0 && (
        <ul className="space-y-1">
          {v.comments.map((c) => (
            <li key={c.id} data-comment={c.id} className="flex items-start gap-2 text-[13px] text-gray-200 rounded-[8px] bg-white/[0.04] px-2.5 py-1.5">
              <span className="flex-1">{c.text}</span>
              <button onClick={() => onUncomment(c.id)} aria-label="Remove this comment" className="text-gray-500 hover:text-gray-200">×</button>
            </li>
          ))}
        </ul>
      )}
      <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (text.trim()) { onComment(text.trim()); setText(''); } }}>
        <input value={text} onChange={(e) => setText(e.target.value)} aria-label={`Comment on ${v.name}`} placeholder="Comment — what works, what doesn’t" className="glass-input flex-1 h-9 px-3 rounded-[10px] text-[13px] text-gray-100" />
        <button type="submit" disabled={!text.trim()} className={`${btn} btn-ghost`}>Comment</button>
      </form>
      <div className="flex items-center gap-2 flex-wrap">
        <button data-select onClick={onSelect} disabled={selected} className={`${btn} ${selected ? 'border border-emerald-400/60 text-emerald-300' : 'btn-primary'}`}>{selected ? '✓ Selected' : 'Select this one'}</button>
        <button data-more-like onClick={onBase} aria-pressed={isBase} className={`${btn} btn-ghost`}>{isBase ? '✓ Exploring this next' : 'More like this'}</button>
      </div>
    </article>
  );
}

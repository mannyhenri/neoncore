import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { FinalAnswer } from '../types';
import { api } from '../lib/api';
import { useEscapeKey } from '../hooks/useEscapeKey';

/**
 * The agent's full final answer — what it said when it handed back, not the 500-character
 * summary line (server lib/final-answer.ts reads it from the transcript). Opened from the
 * Agents screen: the cartridge card, and in the scene the Finished bubble and the crew card.
 */
export function FinalAnswerModal({ agentId, name, onClose }: { agentId: string; name: string; onClose: () => void }) {
  useEscapeKey(onClose);
  const backdropRef = useRef<HTMLDivElement>(null);
  const [answer, setAnswer] = useState<FinalAnswer | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    api.getFinalAnswer(agentId).then((a) => live && setAnswer(a)).catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => { live = false; };
  }, [agentId]);
  const when = answer ? new Date(answer.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

  return createPortal(
    <div
      ref={backdropRef}
      onClick={(e) => { if (e.target === backdropRef.current) onClose(); }}
      className="fixed inset-0 z-overlay bg-black/40 flex items-center justify-center p-4"
      role="dialog" aria-modal="true" aria-label={`${name} — final answer`}
    >
      {/* Capped to the window and clipped; the BODY below is what scrolls. 90% see-through, the
          same as the agent's card over the map — a background alpha, never `opacity` (that would
          also fade the text). */}
      <div
        className="rounded-[22px] border border-[rgba(120,150,255,0.22)] shadow-[0_30px_80px_rgba(0,0,0,0.6)] w-full max-w-3xl mx-2 md:mx-0 max-h-[95vh] md:max-h-[85vh] flex flex-col overflow-hidden"
        style={{ background: 'rgba(10, 16, 32, 0.9)' }}
      >
        <div className="shrink-0 flex items-start justify-between gap-3 px-6 pt-6 pb-4 border-b border-white/[0.08]">
          <div className="min-w-0">
            <h2 className="font-display text-xl font-semibold text-gray-100 truncate">{name} — final answer</h2>
            {answer && (
              <p className="text-[12px] text-gray-500 mt-0.5">
                {when}{answer.complete ? '' : <span className="text-ember-300"> · still working — this is the latest so far</span>}
              </p>
            )}
          </div>
          <button onClick={onClose} className="h-9 w-9 rounded-[10px] text-gray-400 hover:text-gray-100 hover:bg-white/[0.06]" aria-label="Close">✕</button>
        </div>
        {/* flex-1 + min-h-0: take what is left under the header and be ALLOWED to shrink, so a
            long answer scrolls here instead of running off the bottom of the box. */}
        <div data-answer-body tabIndex={0} className="answer-scroll flex-1 min-h-0 overflow-y-auto overscroll-contain px-6 py-5 focus:outline-none">
          {error ? <p className="text-[13px] text-gray-500">{/not found|no answer/i.test(error) ? 'No answer recorded for this cartridge yet.' : error}</p>
            : !answer ? <p className="text-[13px] text-gray-500">Loading…</p>
            : (
              <div className="prose prose-invert prose-sm max-w-none break-words">
                <Markdown remarkPlugins={[remarkGfm]}>{answer.text}</Markdown>
              </div>
            )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

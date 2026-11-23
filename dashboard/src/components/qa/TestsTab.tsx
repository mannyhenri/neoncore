/**
 * TESTS — plain-language tests, one sentence per line. A test with no cached actions yet is sent
 * to the target's cartridge on its first run; after that it replays with no AI calls.
 */
import { useState } from 'react';
import { isCheckSentence, parseSentences } from './sentences';
import type { QaTest } from './types';
import { BTN_GHOST, BTN_PRIMARY, CARD, Empty, INPUT, Loading, SourceBadge } from './ui';

export function SentenceList({ sentences }: { sentences: string[] }) {
  return (
    <ol className="space-y-1 text-[14px]">
      {sentences.map((s, i) => {
        const check = isCheckSentence(s);
        return (
          <li key={i} data-qa-check={check || undefined} className={`flex gap-2 ${check ? 'text-neon-200' : 'text-gray-300'}`}>
            <span className="font-mono text-[12px] text-gray-500 w-5 shrink-0 text-right pt-0.5">{i + 1}.</span>
            <span>{s}{check && <span className="ml-2 rounded-full border border-neon-500/50 px-1.5 text-[10px] font-semibold uppercase tracking-wide text-neon-200 align-middle">check</span>}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function TestsTab({ tests, busy, onCreate, onRun, onDelete }: {
  tests: QaTest[] | undefined;
  busy?: boolean;
  onCreate: (t: { name: string; sentences: string[] }) => Promise<void> | void;
  onRun: (testIds?: string[]) => Promise<void> | void;
  onDelete?: (id: string) => Promise<void> | void;
}) {
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [writing, setWriting] = useState(false);
  const sentences = parseSentences(text);

  const save = async () => {
    if (!name.trim() || sentences.length === 0) return;
    await onCreate({ name: name.trim(), sentences });
    setName(''); setText(''); setWriting(false);
  };

  const editor = (
    <div data-qa-editor className={`${CARD} space-y-3`}>
      <input className={INPUT} placeholder="Test name, e.g. Supervisor submits a daily report" value={name} onChange={(e) => setName(e.target.value)} aria-label="Test name" />
      <textarea
        className={`${INPUT} h-36 py-2 font-mono text-[13px] leading-6`}
        placeholder={'One sentence per line:\nLog in as a supervisor.\nCreate a daily report for project Alpha.\nSubmit it.\nCheck that its status is Awaiting approval.'}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="Test sentences"
      />
      {sentences.length > 0 && (
        <div className="space-y-1">
          <div className="text-[12px] text-gray-500">Preview — sentences starting with Check, Verify, Ensure, Confirm, Expect or Assert are checks: a repair can change how they are done, never what they check.</div>
          <SentenceList sentences={sentences} />
        </div>
      )}
      <div className="flex gap-2 justify-end">
        <button className={BTN_GHOST} onClick={() => { setWriting(false); setName(''); setText(''); }}>Cancel</button>
        <button className={BTN_PRIMARY} disabled={!name.trim() || sentences.length === 0 || busy} onClick={save}>Save test</button>
      </div>
    </div>
  );

  if (tests === undefined) return <Loading what="tests" />;
  if (tests.length === 0) {
    return (
      <div className="space-y-4">
        <Empty art="empty-tests" title="No tests yet">
          <p>Write a test as a few plain sentences. The first run, the target's cartridge works out the browser actions and caches them; every run after that replays them with no AI calls.</p>
          {!writing && <button className={BTN_PRIMARY} onClick={() => setWriting(true)}>+ Write a test</button>}
        </Empty>
        {writing && editor}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <button className={BTN_PRIMARY} disabled={busy} onClick={() => onRun()}>▶ Run all ({tests.length})</button>
        {!writing && <button className={BTN_GHOST} onClick={() => setWriting(true)}>+ Write a test</button>}
      </div>
      {writing && editor}
      <ul className="space-y-3">
        {tests.map((t) => (
          <li key={t.id} data-qa-test={t.id} className={`${CARD} space-y-3`}>
            <div className="flex items-start gap-3 flex-wrap">
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-gray-100">{t.name}</div>
                <div className="flex items-center gap-2 mt-1 text-[12px] text-gray-400">
                  <SourceBadge source={t.source} />
                  <span data-qa-cached={t.cache ? 'yes' : 'no'}>{t.cache ? 'Cached — replays with no AI calls' : 'Not cached yet — the first run asks the cartridge'}</span>
                </div>
              </div>
              <button className={BTN_GHOST} disabled={busy} onClick={() => onRun([t.id])}>▶ Run</button>
              {onDelete && <button className="h-10 px-3 rounded-[10px] text-[13px] border border-red-400/45 text-red-200" onClick={() => onDelete(t.id)}>Delete</button>}
            </div>
            <SentenceList sentences={t.sentences} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * THE SOUND CONTROLS — the speaker button beside the bell (mute everything), and Settings → Sound.
 */
import { useEffect, useState } from 'react';
import { getSound, onSound, setSound, type SoundSettings } from '../lib/sound/settings';
import { CUES, CUE_SPECS } from '../lib/sound/cues';
import { previewCue } from '../lib/sound/engine';

export function useSoundSettings(): SoundSettings {
  const [s, setS] = useState(getSound);
  useEffect(() => onSound(setS), []);
  return s;
}

/** The speaker beside the bell: one click mutes or unmutes everything. */
export function SoundButton() {
  const s = useSoundSettings();
  return (
    <button type="button" data-sound-button data-muted={s.muted || undefined} aria-pressed={s.muted} onClick={() => setSound({ muted: !s.muted })}
      aria-label={s.muted ? 'Sound is off — turn it on' : 'Sound is on — mute it'} title={s.muted ? 'Sound is off' : 'Mute sound'}
      className="relative h-10 w-10 btn-ghost rounded-[10px] flex items-center justify-center text-gray-300 hover:text-white transition-colors">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M11 5 6 9H3v6h3l5 4V5z" />
        {s.muted ? <><path d="m16 9 5 6" /><path d="m21 9-5 6" /></> : <><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M18.5 5.5a9 9 0 0 1 0 13" /></>}
      </svg>
    </button>
  );
}

function Level({ label, hint, value, onChange, name }: { label: string; hint: string; value: number; onChange: (v: number) => void; name: string }) {
  return (
    <label className="flex items-center gap-4">
      <span className="w-[150px] shrink-0">
        <span className="block text-[14px] text-gray-200">{label}</span>
        <span className="block text-[12px] text-gray-500">{hint}</span>
      </span>
      <input type="range" min={0} max={100} step={5} value={Math.round(value * 100)} data-sound-level={name} onChange={(e) => onChange(Number(e.target.value) / 100)} className="flex-1 accent-neon-500" />
      <span className="w-10 text-right text-[13px] text-gray-400 tabular-nums">{Math.round(value * 100)}%</span>
    </label>
  );
}

function Switch({ label, hint, on, onChange, name }: { label: string; hint: string; on: boolean; onChange: (v: boolean) => void; name: string }) {
  return (
    <label className="flex items-center gap-4 cursor-pointer">
      <span className="flex-1">
        <span className="block text-[14px] text-gray-200">{label}</span>
        <span className="block text-[12px] text-gray-500">{hint}</span>
      </span>
      <input type="checkbox" role="switch" aria-checked={on} checked={on} data-sound-switch={name} onChange={(e) => onChange(e.target.checked)} className="h-5 w-5 accent-neon-500" />
    </label>
  );
}

/** Settings → Sound. */
export function SoundSettingsPanel() {
  const s = useSoundSettings();
  return (
    <div className="px-4 py-4 md:px-6 space-y-5" data-sound-settings>
      <p className="text-[13px] text-gray-400 leading-relaxed">
        A quiet ambient loop, a few interface sounds, and one cue per kind of event. Kept in this browser.
        A browser only allows sound after your first click on the page, so the app is silent until then.
      </p>
      <Switch name="muted" label="Sound" hint="The speaker button beside the bell does the same" on={!s.muted} onChange={(v) => setSound({ muted: !v })} />
      <Level name="volume" label="Volume" hint="Everything" value={s.volume} onChange={(volume) => setSound({ volume })} />
      <Level name="ambient" label="Ambient" hint="0% turns the loop off" value={s.ambient} onChange={(ambient) => setSound({ ambient })} />
      <Switch name="ui" label="Interface sounds" hint="Buttons, tabs, opening an agent's card, sending a command" on={s.ui} onChange={(ui) => setSound({ ui })} />
      <Switch name="cues" label="Event cues" hint="One sound per kind of event, listed below" on={s.cues} onChange={(cues) => setSound({ cues })} />
      <div>
        <p className="text-[12px] tracking-[0.12em] uppercase text-gray-500 mb-2">Event cues</p>
        <ul className="divide-y divide-white/[0.06] border border-white/[0.08] rounded-[12px]">
          {CUES.map((cue) => (
            <li key={cue} data-cue={cue} className="flex items-center gap-3 px-3 py-2">
              <span className="flex-1 min-w-0">
                <span className="block text-[14px] text-gray-200">{CUE_SPECS[cue].label}{CUE_SPECS[cue].warning && <span className="ml-2 text-[11px] text-ember-300">warning</span>}</span>
                <span className="block text-[12px] text-gray-500">{CUE_SPECS[cue].when}</span>
              </span>
              <button type="button" data-sound="none" onClick={() => previewCue(cue)} className="btn-ghost h-8 px-3 rounded-[9px] text-[12px] font-semibold" aria-label={`Preview the ${CUE_SPECS[cue].label} cue`}>Preview</button>
            </li>
          ))}
        </ul>
        <p className="text-[12px] text-gray-500 mt-2">Warnings also play when this tab is in the background. Several of the same event at once play one cue.</p>
      </div>
    </div>
  );
}

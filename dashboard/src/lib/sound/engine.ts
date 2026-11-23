/**
 * THE SOUND ENGINE — plays the files (sounds.generated.ts) through Web Audio. Each world theme
 * has its own set of the same fifteen sounds; the page plays the set of the theme it was loaded with.
 *
 *   · Browsers allow sound only after a click or key press on the page: the engine starts on the
 *     first one, and is silent until then.
 *   · There is no background loop: between sounds the app is silent.
 *   · Whether a cue may play is cues.ts; what is switched on is settings.ts. This file only plays.
 *
 * A browser with no Web Audio (and every test) gets a silent engine: nothing here throws.
 */
import { SOUND_FILES, SOUND_PACKS, type SoundId } from './sounds.generated';
import { THEME } from '../../world/theme';
import { CUE_SPECS, createCueGate, type Cue, type UiSound } from './cues';
import { getSound, onSound, type SoundSettings } from './settings';

/** This page's sounds: the set of the world theme it was loaded with (the sci-fi set when a theme has none). */
export const SOUNDS = SOUND_PACKS[THEME] ?? SOUND_FILES;
const UI_GAIN = 0.5;
const CUE_GAIN = 0.9;

type Ctx = AudioContext;
let ctx: Ctx | null = null;
let master: GainNode | null = null;
const buffers = new Map<SoundId, Promise<AudioBuffer | null>>();
const gate = createCueGate(Date.now());
/** When open / close / send last played: the plain tap of the same click is dropped. */
let lastSpecial = 0;

function settingsGain(s: SoundSettings): number { return s.muted ? 0 : s.volume; }

function ensure(): Ctx | null {
  if (ctx) return ctx;
  const Ctor = typeof window === 'undefined' ? undefined : (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = settingsGain(getSound());
    master.connect(ctx.destination);
  } catch { ctx = null; }
  return ctx;
}

function buffer(id: SoundId): Promise<AudioBuffer | null> {
  const c = ensure();
  if (!c) return Promise.resolve(null);
  let b = buffers.get(id);
  if (!b) {
    b = fetch(SOUNDS[id].src).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status))))).then((data) => c.decodeAudioData(data)).catch(() => null);
    buffers.set(id, b);
  }
  return b;
}

async function playFile(id: SoundId, gain: number): Promise<boolean> {
  const c = ensure();
  if (!c || !master || c.state !== 'running') return false;
  const b = await buffer(id);
  if (!b) return false;
  const src = c.createBufferSource();
  src.buffer = b;
  const g = c.createGain();
  g.gain.value = gain;
  src.connect(g).connect(master);
  src.start();
  return true;
}

/** An interface sound: a tap, an open, a send. Never gated — it answers the person's own action. */
export function playUi(id: UiSound): void {
  const s = getSound();
  if (s.muted || !s.ui) return;
  if (id === 'ui-tap' || id === 'ui-primary') {
    // The click may turn out to open a card or send a command, which has its own sound: wait
    // for the click to be handled, and stay quiet if it did.
    const at = Date.now();
    setTimeout(() => { if (lastSpecial < at) void playFile(id, UI_GAIN); }, 0);
    return;
  }
  lastSpecial = Date.now();
  void playFile(id, UI_GAIN);
}

/** An event cue, if the rules (cues.ts) allow one now. Returns whether it was allowed. */
export function playCue(cue: Cue): boolean {
  const s = getSound();
  if (s.muted || !s.cues) return false;
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
  if (!gate.allow(cue, Date.now(), { hidden })) return false;
  void playFile(CUE_SPECS[cue].sound, CUE_GAIN);
  return true;
}

/** Settings → Sound "Preview": the cue itself, whatever the gate would say. */
export function previewCue(cue: Cue): void {
  if (!ensure()) return;
  void ctx!.resume().then(() => playFile(CUE_SPECS[cue].sound, CUE_GAIN));
}

let started = false;
/** Wire the engine to the page: start on the first click or key, and follow the settings. */
export function startSound(): () => void {
  if (started || typeof window === 'undefined') return () => {};
  started = true;
  const unlock = () => {
    const c = ensure();
    if (!c) return;
    void c.resume().catch(() => {});
  };
  window.addEventListener('pointerdown', unlock, { capture: true });
  window.addEventListener('keydown', unlock, { capture: true });
  const off = onSound((s) => {
    if (ctx && master) master.gain.setTargetAtTime(settingsGain(s), ctx.currentTime, 0.05);
  });
  return () => {
    started = false;
    window.removeEventListener('pointerdown', unlock, { capture: true });
    window.removeEventListener('keydown', unlock, { capture: true });
    off();
  };
}

/** Which interface sound a click on this element makes; null for a click on nothing in particular. */
export function uiSoundFor(target: Element | null): UiSound | null {
  const el = target?.closest('button, [role="tab"], [role="switch"], [role="button"], a[href], input[type="checkbox"], input[type="radio"], summary');
  if (!el || (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') return null;
  // These make their own sound (open / close / send), or must stay silent.
  if (el.closest('[data-sound="none"]')) return null;
  return el.classList.contains('btn-primary') ? 'ui-primary' : 'ui-tap';
}

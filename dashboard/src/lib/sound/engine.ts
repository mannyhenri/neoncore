/**
 * THE SOUND ENGINE — plays the files (sounds.generated.ts) through Web Audio.
 *
 *   · Browsers allow sound only after a click or key press on the page: the engine starts on the
 *     first one, and is silent until then.
 *   · The ambient loop overlaps consecutive copies (each fades in and out), so no loop point is
 *     heard; it stops while the tab is in the background, and dips under every cue.
 *   · Whether a cue may play is cues.ts; what is switched on is settings.ts. This file only plays.
 *
 * A browser with no Web Audio (and every test) gets a silent engine: nothing here throws.
 */
import { SOUND_FILES, AMBIENT_OVERLAP, type SoundId } from './sounds.generated';
import { CUE_SPECS, createCueGate, type Cue, type UiSound } from './cues';
import { getSound, onSound, type SoundSettings } from './settings';

const UI_GAIN = 0.5;
const CUE_GAIN = 0.9;
const AMBIENT_GAIN = 0.5;
/** How far the ambient loop dips under a cue, and for how long. */
const DUCK = { to: 0.35, downS: 0.08, holdS: 1.2, upS: 0.9 };

type Ctx = AudioContext;
let ctx: Ctx | null = null;
let master: GainNode | null = null;
let ambientBus: GainNode | null = null;
const buffers = new Map<SoundId, Promise<AudioBuffer | null>>();
let ambientTimer: ReturnType<typeof setTimeout> | null = null;
let ambientLive: AudioBufferSourceNode[] = [];
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
    ambientBus = ctx.createGain();
    ambientBus.gain.value = getSound().ambient * AMBIENT_GAIN;
    ambientBus.connect(master);
  } catch { ctx = null; }
  return ctx;
}

function buffer(id: SoundId): Promise<AudioBuffer | null> {
  const c = ensure();
  if (!c) return Promise.resolve(null);
  let b = buffers.get(id);
  if (!b) {
    b = fetch(SOUND_FILES[id].src).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status))))).then((data) => c.decodeAudioData(data)).catch(() => null);
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

function duck(): void {
  if (!ctx || !ambientBus) return;
  const level = getSound().ambient * AMBIENT_GAIN;
  const now = ctx.currentTime;
  ambientBus.gain.cancelScheduledValues(now);
  ambientBus.gain.setTargetAtTime(level * DUCK.to, now, DUCK.downS);
  ambientBus.gain.setTargetAtTime(level, now + DUCK.holdS, DUCK.upS);
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
  duck();
  void playFile(CUE_SPECS[cue].sound, CUE_GAIN);
  return true;
}

/** Settings → Sound "Preview": the cue itself, whatever the gate would say. */
export function previewCue(cue: Cue): void {
  if (!ensure()) return;
  void ctx!.resume().then(() => playFile(CUE_SPECS[cue].sound, CUE_GAIN));
}

function stopAmbient(): void {
  if (ambientTimer) clearTimeout(ambientTimer);
  ambientTimer = null;
  for (const src of ambientLive) { try { src.stop(); } catch { /* already stopped */ } }
  ambientLive = [];
}

async function startAmbient(): Promise<void> {
  const c = ensure();
  if (!c || !ambientBus || ambientTimer || c.state !== 'running') return;
  const b = await buffer('ambient');
  if (!b || ambientTimer) return;
  const next = () => {
    if (!ctx || !ambientBus) return;
    const src = ctx.createBufferSource();
    src.buffer = b;
    src.connect(ambientBus);
    src.start();
    ambientLive.push(src);
    src.onended = () => { ambientLive = ambientLive.filter((x) => x !== src); };
    // The next copy starts while this one is fading out.
    ambientTimer = setTimeout(next, Math.max(1, b.duration - AMBIENT_OVERLAP) * 1000);
  };
  next();
}

function syncAmbient(): void {
  const s = getSound();
  const wanted = !s.muted && s.ambient > 0 && typeof document !== 'undefined' && document.visibilityState === 'visible';
  if (wanted) void startAmbient(); else stopAmbient();
}

let started = false;
/** Wire the engine to the page: start on the first click or key, follow the settings and the tab. */
export function startSound(): () => void {
  if (started || typeof window === 'undefined') return () => {};
  started = true;
  const unlock = () => {
    const c = ensure();
    if (!c) return;
    void c.resume().then(syncAmbient).catch(() => {});
  };
  const onVisible = () => syncAmbient();
  window.addEventListener('pointerdown', unlock, { capture: true });
  window.addEventListener('keydown', unlock, { capture: true });
  document.addEventListener('visibilitychange', onVisible);
  const off = onSound((s) => {
    if (ctx && master && ambientBus) {
      master.gain.setTargetAtTime(settingsGain(s), ctx.currentTime, 0.05);
      ambientBus.gain.setTargetAtTime(s.ambient * AMBIENT_GAIN, ctx.currentTime, 0.1);
    }
    syncAmbient();
  });
  return () => {
    started = false;
    window.removeEventListener('pointerdown', unlock, { capture: true });
    window.removeEventListener('keydown', unlock, { capture: true });
    document.removeEventListener('visibilitychange', onVisible);
    off();
    stopAmbient();
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

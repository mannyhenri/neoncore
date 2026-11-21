/**
 * THE SOUND SETTINGS — kept in this browser, like the theme.
 *
 *   muted     the speaker button: everything off
 *   volume    master, 0–1
 *   ambient   the ambient loop's level, 0–1 (0 = off)
 *   ui        interface sounds on/off
 *   cues      event cues on/off
 */
export interface SoundSettings { muted: boolean; volume: number; ambient: number; ui: boolean; cues: boolean }
export const SOUND_KEY = 'neoncore.sound';
export const DEFAULT_SOUND: SoundSettings = { muted: false, volume: 0.7, ambient: 0.35, ui: true, cues: true };

const unit = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback);
const flag = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);

/** Whatever was stored, as valid settings: a missing or broken value falls back to its default. */
export function parseSound(raw: string | null | undefined): SoundSettings {
  let v: Record<string, unknown> = {};
  try { const p = raw ? JSON.parse(raw) : null; if (p && typeof p === 'object' && !Array.isArray(p)) v = p as Record<string, unknown>; } catch { /* broken value: defaults */ }
  return { muted: flag(v.muted, DEFAULT_SOUND.muted), volume: unit(v.volume, DEFAULT_SOUND.volume), ambient: unit(v.ambient, DEFAULT_SOUND.ambient), ui: flag(v.ui, DEFAULT_SOUND.ui), cues: flag(v.cues, DEFAULT_SOUND.cues) };
}

function load(): SoundSettings {
  try { return parseSound(typeof window === 'undefined' ? null : window.localStorage.getItem(SOUND_KEY)); } catch { return { ...DEFAULT_SOUND }; }
}

let current = load();
const listeners = new Set<(s: SoundSettings) => void>();

export const getSound = (): SoundSettings => current;
export function setSound(patch: Partial<SoundSettings>): SoundSettings {
  current = parseSound(JSON.stringify({ ...current, ...patch }));
  try { window.localStorage.setItem(SOUND_KEY, JSON.stringify(current)); } catch { /* private mode: kept for this page only */ }
  for (const l of listeners) l(current);
  return current;
}
export function onSound(listener: (s: SoundSettings) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

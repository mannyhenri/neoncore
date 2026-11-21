/**
 * WHICH SOUND, AND WHETHER TO PLAY IT — pure, so every rule is tested without a speaker.
 *
 * One cue per KIND of event, never one per event:
 *
 *   needs-you       an approval, a question or a plan to review; a workflow or feature waiting on you
 *   stuck           an agent looks stuck
 *   failed          a step, run or task failed, or a feature's pipeline stopped
 *   quota           the Claude quota crossed 90% (the core overheats), on any screen
 *   run-finished    a workflow run completed, or a feature's report is ready
 *   delivered       a feature was delivered (the flare on the map)
 *   launched        a new cartridge came online
 *   notice          any other workflow notice
 *   turn-finished   an agent finished its turn, or a task was done
 *
 * And the rules that keep it sparse (CueGate):
 *   · nothing in the first 6 seconds after the page opens
 *   · the same cue again inside its cooldown is dropped — ten approvals at once are one sound
 *   · a less important cue within 3 seconds of a more important one is dropped — the end of a
 *     run is one sound, not two
 *   · at most 8 cues a minute; the four warnings always get through
 *   · in a background tab only the warnings play
 */
import type { SoundId } from './sounds.generated';

export const CUES = ['needs-you', 'stuck', 'failed', 'quota', 'run-finished', 'delivered', 'launched', 'notice', 'turn-finished'] as const;
export type Cue = (typeof CUES)[number];

export interface CueSpec {
  sound: SoundId;
  label: string;
  /** What sets it off, in the words Settings shows. */
  when: string;
  /** Higher = more important. */
  rank: number;
  /** A warning: plays in a background tab, and is never held back by the per-minute cap. */
  warning: boolean;
  /** The same cue is not played again within this long. */
  cooldownMs: number;
}

export const CUE_SPECS: Record<Cue, CueSpec> = {
  'needs-you': { sound: 'cue-needs-you', label: 'Needs you', when: 'An approval, question or plan to review; a workflow or feature waiting on you', rank: 8, warning: true, cooldownMs: 8_000 },
  stuck: { sound: 'cue-stuck', label: 'Agent stuck', when: 'An agent looks stuck', rank: 7, warning: true, cooldownMs: 20_000 },
  failed: { sound: 'cue-failed', label: 'Something failed', when: 'A step, run or task fails, or a feature pipeline stops', rank: 9, warning: true, cooldownMs: 8_000 },
  quota: { sound: 'cue-quota', label: 'Quota nearly gone', when: 'The Claude quota crosses 90% (the core overheats), on any screen', rank: 10, warning: true, cooldownMs: 10 * 60_000 },
  'run-finished': { sound: 'cue-run-finished', label: 'Run finished', when: 'A workflow run completes, or a feature’s report is ready', rank: 5, warning: false, cooldownMs: 6_000 },
  delivered: { sound: 'cue-delivered', label: 'Feature delivered', when: 'A feature is delivered (the flare on the map)', rank: 6, warning: false, cooldownMs: 6_000 },
  launched: { sound: 'cue-launched', label: 'Cartridge launched', when: 'A new cartridge comes online', rank: 3, warning: false, cooldownMs: 6_000 },
  notice: { sound: 'cue-notice', label: 'Notice', when: 'Any other workflow notice', rank: 2, warning: false, cooldownMs: 6_000 },
  'turn-finished': { sound: 'cue-turn-finished', label: 'Turn finished', when: 'An agent finishes its turn, or a task is done', rank: 1, warning: false, cooldownMs: 10_000 },
};

export const UI_SOUNDS = ['ui-tap', 'ui-primary', 'ui-open', 'ui-close', 'ui-send'] as const satisfies readonly SoundId[];
export type UiSound = (typeof UI_SOUNDS)[number];

export const QUIET_START_MS = 6_000;
export const SHADOW_MS = 3_000;
export const CUES_PER_MINUTE = 8;

/** The kinds the server labels a workflow or feature notification with (server lib/notification-kind.ts). */
export const NOTIFICATION_KINDS = ['needs-you', 'failed', 'finished', 'notice'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
const KIND_CUE: Record<NotificationKind, Cue> = { 'needs-you': 'needs-you', failed: 'failed', finished: 'run-finished', notice: 'notice' };

/**
 * The cue for a workflow or feature notification. The server says its kind; a server from before
 * that still works — the kind is read off the title it wrote.
 */
export function cueForNotification(n: { kind?: string; title: string }): Cue {
  if (n.kind && (NOTIFICATION_KINDS as readonly string[]).includes(n.kind)) return KIND_CUE[n.kind as NotificationKind];
  const title = n.title.toLowerCase();
  if (/fail|interrupt|stopped|stalled|did not answer|over budget|were changed|error/.test(title)) return 'failed';
  if (/needs|waiting|ready to (advance|review)|to answer|to review|to confirm|decision|approv|question/.test(title)) return 'needs-you';
  if (/done|complete|finished|report ready/.test(title)) return 'run-finished';
  return 'notice';
}

export interface CueGate {
  /** Should this cue sound now? Recording it as played when the answer is yes. */
  allow(cue: Cue, now: number, opts?: { hidden?: boolean }): boolean;
}

/** The gate for one open page; `openedAt` is when the page opened. */
export function createCueGate(openedAt: number): CueGate {
  const lastOf = new Map<Cue, number>();
  let played: { cue: Cue; at: number }[] = [];
  return {
    allow(cue, now, opts = {}) {
      const spec = CUE_SPECS[cue];
      if (now - openedAt < QUIET_START_MS) return false;
      if (opts.hidden && !spec.warning) return false;
      const last = lastOf.get(cue);
      if (last !== undefined && now - last < spec.cooldownMs) return false;
      played = played.filter((p) => now - p.at < 60_000);
      if (played.some((p) => now - p.at < SHADOW_MS && CUE_SPECS[p.cue].rank > spec.rank)) return false;
      if (!spec.warning && played.length >= CUES_PER_MINUTE) return false;
      lastOf.set(cue, now);
      played.push({ cue, at: now });
      return true;
    },
  };
}

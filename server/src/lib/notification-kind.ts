/**
 * WHAT KIND OF NOTIFICATION IS THIS — said by the server, so nobody has to guess from a title.
 *
 * Every `workflow_notification` (the dashboard's bell) carries one of four kinds. The dashboard
 * plays a different sound for each (dashboard/src/lib/sound/cues.ts), and anything else that
 * shows the bell's items can tell "this needs you" from "this failed" from "this is done".
 *
 *   needs-you   something waits on a person: a decision, an answer, a review, a cartridge to start
 *   failed      a step, a run or a feature's pipeline stopped on a failure
 *   finished    a run completed, or a feature's report or PRs are ready
 *   notice      anything else worth saying (a budget warning)
 */
export const NOTIFICATION_KINDS = ['needs-you', 'failed', 'finished', 'notice'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Feature (goal pilot) events that mean it stopped on a failure rather than on a question. */
export const PILOT_FAILED_EVENTS = ['paused', 'planner-failed', 'tests-tampered'] as const;
/** Feature events that mean something is finished and ready to look at. */
export const PILOT_FINISHED_EVENTS = ['completed', 'prs-opened'] as const;

/** The kind of a feature announcement (goal-pilot-runner.ts announcePilot). */
export function pilotEventKind(event: string, urgency: 'action' | 'info'): NotificationKind {
  if ((PILOT_FAILED_EVENTS as readonly string[]).includes(event)) return 'failed';
  if ((PILOT_FINISHED_EVENTS as readonly string[]).includes(event)) return 'finished';
  return urgency === 'action' ? 'needs-you' : 'notice';
}

/** The kind of a run's "needs attention" notification, from its push type (workflow-executor-v2.ts). */
export function attentionKind(pushType: string): NotificationKind {
  return /failed|interrupted|stalled/.test(pushType) ? 'failed' : 'needs-you';
}

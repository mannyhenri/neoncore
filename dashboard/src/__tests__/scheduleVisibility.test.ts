import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { armedSchedules, type Heartbeat } from '@neoncore/client';

/**
 * A SCHEDULE YOU JUST CREATED HAS TO APPEAR WHERE YOU CREATED IT.
 *
 * Reported as "I just tried to start a daily scheduled task with repeat on, but it doesn't
 * even show in the list of tasks". Nothing underneath was broken: the heartbeat was created,
 * armed, fired on time and re-armed for the next day. It was invisible. The only surfaces
 * listing schedules were a per-project modal on GoalsPage and the per-template popover that
 * created it — neither is the list you are looking at after clicking Run.
 *
 * SET-BASED OVER THE CADENCE REGISTRY, because a list that renders `daily` and silently drops
 * `quarterly` looks identical from the cadence you happened to test. The registry is also
 * where the second defect lived: the shared Heartbeat type allowed only 3 of the server's 6
 * cadences, so half of them were not merely unrendered but unrepresentable.
 */
const CADENCES = ['once', 'hourly', 'daily', 'weekly', 'monthly', 'quarterly'] as const;

const hb = (over: Partial<Heartbeat>): Heartbeat => ({
  id: 'h1', projectId: null, templateId: 't1', templateName: 'Daily AI Research Digest',
  agentId: 'a1', agentName: 'gl-dev', schedule: { type: 'daily', time: '09:10' },
  scheduleLabel: 'Daily at 09:10', label: 'Daily AI Research Digest', active: true,
  lastRunAt: null, nextRunAt: '2026-09-20T13:10:00.000Z', createdAt: '2026-09-19T13:04:51.130Z',
  ...over,
});

describe('armed schedules are listable for every cadence', () => {
  it('accepts and returns all six cadences', () => {
    // The TYPE half of this is enforced by `tsc --noEmit`: with the old 3-cadence union this
    // file does not compile. The runtime half is that none is filtered out.
    const all = CADENCES.map((type, i) =>
      hb({ id: `h-${i}`, schedule: { type, time: '09:10' }, scheduleLabel: `${type} label` }));
    expect(armedSchedules(all).map((h) => h.schedule.type)).toEqual([...CADENCES]);
  });

  it('drops inactive schedules — a fired one-off is history, not something upcoming', () => {
    const fired = hb({ id: 'done', active: false, schedule: { type: 'once' }, lastRunAt: '2026-09-19T13:10:44Z' });
    expect(armedSchedules([fired, hb({ id: 'live' })]).map((h) => h.id)).toEqual(['live']);
  });

  it('orders by next run, so the next thing to happen is first', () => {
    const later = hb({ id: 'later', nextRunAt: '2026-09-21T09:00:00.000Z' });
    const sooner = hb({ id: 'sooner', nextRunAt: '2026-09-19T18:00:00.000Z' });
    expect(armedSchedules([later, sooner]).map((h) => h.id)).toEqual(['sooner', 'later']);
  });

  it('keeps a schedule with an unparseable next run rather than hiding it', () => {
    // Hiding it would make a real, armed schedule invisible — the exact complaint. Sort it
    // last instead, where it is still visible and obviously odd.
    const bad = hb({ id: 'bad', nextRunAt: 'not-a-date' });
    expect(armedSchedules([bad, hb({ id: 'ok' })]).map((h) => h.id)).toEqual(['ok', 'bad']);
  });
});

/**
 * The surface scan. Comments are stripped first — a check a comment can satisfy is not a
 * check, which this repo learned from the confer dedupe tripwire one commit ago.
 */
describe('the main workflows surface lists armed schedules', () => {
  const root = path.resolve(__dirname, '../../..');
  const code = (f: string) => fs.readFileSync(f, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('WorkflowPanel renders them, not just the launch control that creates them', () => {
    const panel = path.join(root, 'dashboard/src/components/WorkflowPanel.tsx');
    const src = code(panel);
    expect(/createHeartbeat\s*\(/.test(src),
      'WorkflowPanel no longer creates schedules — re-point this test').toBe(true);
    expect(/armedSchedules\s*\(/.test(src),
      'WorkflowPanel creates schedules but never lists them, so a schedule you just made is '
      + 'invisible on the surface you made it from').toBe(true);
  });
});

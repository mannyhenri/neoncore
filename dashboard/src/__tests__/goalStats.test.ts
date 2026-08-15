import { describe, it, expect } from 'vitest';
import { unassignedProjects, unassignedNotice } from '../lib/goalStats';
import type { Project } from '@neoncore/client';

/**
 * The counter that keeps an optional link honest.
 *
 * Requiring a goal on every project was rejected — quick project creation must stay
 * frictionless. That makes visibility the entire safety mechanism: an unattached project
 * contributes nothing to reach, nothing to cost, and receives no goal brief, and previously
 * nothing said so. Three projects sat that way for a week.
 */
const p = (over: Partial<Project> = {}): Project =>
  ({ id: 'x', name: 'n', description: '', goalId: null, primaryRepo: '', color: '#fff',
     createdAt: '', updatedAt: '', ...over } as Project);

describe('unassigned project accounting', () => {
  it('counts projects with no goal', () => {
    expect(unassignedProjects([p(), p({ goalId: 'g1' }), p()]).length).toBe(2);
  });

  it('treats an empty-string goalId as unassigned, not as a link', () => {
    // The column is nullable AND defaults to ''. A count that only tested for null would
    // under-report and re-hide exactly what this exists to show.
    expect(unassignedProjects([p({ goalId: '' })]).length).toBe(1);
  });

  it('says nothing when everything is attached', () => {
    // A banner that is always present is a banner nobody reads.
    expect(unassignedNotice([p({ goalId: 'g1' })])).toBeNull();
    expect(unassignedNotice([])).toBeNull();
  });

  it('names the consequence, not just the number', () => {
    // "3 unassigned" is a statistic. "their cost and intent roll up to nothing" is the reason
    // anyone should care, and it is what was invisible before.
    const notice = unassignedNotice([p(), p(), p()])!;
    expect(notice).toMatch(/3 projects/);
    expect(notice).toMatch(/roll up to nothing/);
  });

  it('reads correctly in the singular', () => {
    expect(unassignedNotice([p()])).toMatch(/^1 project has no goal/);
  });
});

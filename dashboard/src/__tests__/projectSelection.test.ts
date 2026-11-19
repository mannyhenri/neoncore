import { describe, it, expect } from 'vitest';
import {
  UNFILED, parseProjectHash, projectHash, isProjectsHash, resolveProjectSelection,
} from '../lib/projectSelection';

/**
 * The Projects view's selection lives in the URL (replaces goalSelection, V6 drop). Set-based over
 * id shapes and over every stale case, so a fix for one shape cannot leave another blank.
 */

const IDS = ['p1', 'demo-p2', '8f2c1a90-4b1e-4c3a-9d5e-0f1a2b3c4d5e', 'with space', 'a/b'];

describe('a project or feature is addressable', () => {
  it.each(IDS)('project %s survives a round trip through the URL hash', (id) => {
    expect(parseProjectHash(projectHash(id))).toEqual({ projectId: id, featureId: null });
  });

  it.each(IDS)('feature %s inside a project survives a round trip', (id) => {
    expect(parseProjectHash(projectHash('p1', id))).toEqual({ projectId: 'p1', featureId: id });
  });

  it.each(['#goal/g7', '#goal=g7'])('the pre-projects link %s still names a feature', (hash) => {
    expect(parseProjectHash(hash)).toEqual({ projectId: null, featureId: 'g7' });
    expect(isProjectsHash(hash)).toBe(true);
  });

  it.each(['', '#', '#agents', '#project/', '#goal/', '#projects/p1', '#project/p1/feature/'])(
    '%j is not a projects link', (hash) => {
      expect(parseProjectHash(hash)).toBeNull();
      expect(isProjectsHash(hash)).toBe(false);
    },
  );
});

describe('the selection always resolves to something showable', () => {
  const base = { projectIds: ['p1', 'p2'], features: [{ id: 'f1', projectId: 'p2' }, { id: 'f9', projectId: null }], hasUnfiled: true };

  it('an explicit, existing project wins', () => {
    expect(resolveProjectSelection({ ...base, requested: { projectId: 'p2', featureId: null } })).toEqual({ projectId: 'p2', featureId: null });
  });

  it('a feature asked for on its own opens in its own project', () => {
    expect(resolveProjectSelection({ ...base, requested: { projectId: null, featureId: 'f1' } })).toEqual({ projectId: 'p2', featureId: 'f1' });
  });

  it('a feature with no project opens under unfiled', () => {
    expect(resolveProjectSelection({ ...base, requested: { projectId: null, featureId: 'f9' } })).toEqual({ projectId: UNFILED, featureId: 'f9' });
  });

  const STALE = [
    { label: 'a deleted project', requested: { projectId: 'gone', featureId: null } },
    { label: 'a deleted feature', requested: { projectId: null, featureId: 'gone' } },
    { label: 'no request at all', requested: null },
  ];
  it.each(STALE)('$label falls back to the first project, not a blank pane', ({ requested }) => {
    expect(resolveProjectSelection({ ...base, requested })).toEqual({ projectId: 'p1', featureId: null });
  });

  it('unfiled is selectable exactly when unfiled features exist', () => {
    expect(resolveProjectSelection({ ...base, requested: { projectId: UNFILED, featureId: null } }).projectId).toBe(UNFILED);
    expect(resolveProjectSelection({ ...base, hasUnfiled: false, requested: { projectId: UNFILED, featureId: null } }).projectId).toBe('p1');
  });

  it('a genuinely empty workspace resolves to null, not to a fabricated id', () => {
    expect(resolveProjectSelection({ projectIds: [], features: [], hasUnfiled: false, requested: null })).toEqual({ projectId: null, featureId: null });
  });
});

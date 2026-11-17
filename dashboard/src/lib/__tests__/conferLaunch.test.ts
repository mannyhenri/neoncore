import { describe, expect, it } from 'vitest';
import { CONFER_EPIC_LINE, conferLaunchContext, normalizeEpicKey } from '../conferLaunch';

describe('Confer launch context', () => {
  it('a task alone is passed through unchanged', () => {
    expect(conferLaunchContext('  Add refunds to the ledger API and the dashboard  ', '')).toBe(
      'Add refunds to the ledger API and the dashboard');
  });

  it('an epic alone becomes the JIRA EPIC line the Scope step looks for', () => {
    expect(conferLaunchContext('', 'GRD-1712')).toBe(`${CONFER_EPIC_LINE} GRD-1712`);
  });

  it('an epic and a task: the epic line first, then the task as direction', () => {
    expect(conferLaunchContext('Backend first, keep the API stable', 'grd-1712')).toBe(
      `${CONFER_EPIC_LINE} GRD-1712\n\nBackend first, keep the API stable`);
  });

  it('neither gives an empty context, so the form can refuse to launch', () => {
    expect(conferLaunchContext('  ', '  ')).toBe('');
  });

  it.each([
    ['GRD-1712', 'GRD-1712'],
    ['  grd-1712 ', 'GRD-1712'],
    ['https://acme.atlassian.net/browse/GRD-1712', 'GRD-1712'],
    ['https://acme.atlassian.net/jira/software/projects/GRD/issues/GRD-88?filter=x', 'GRD-88'],
    ['', ''],
  ])('normalizes %j to %j', (raw, key) => {
    expect(normalizeEpicKey(raw)).toBe(key);
  });

  it('text that is not a key is kept as typed, for the agent to resolve', () => {
    expect(normalizeEpicKey('Document Generation')).toBe('Document Generation');
  });
});

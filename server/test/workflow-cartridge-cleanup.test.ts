import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { staleMissingRepoAgentIds } from '../src/lib/stale-agent-cleanup.ts';
import { workflowAgentOptions } from '../../dashboard/src/lib/workflow-agent-options.ts';

test('the complete cleanup matrix deletes only offline local cartridges whose repo disappeared', () => {
  const cases = [
    { id: 'local-offline-missing', status: 'offline', local: true, exists: false, stale: true },
    { id: 'local-offline-present', status: 'offline', local: true, exists: true, stale: false },
    { id: 'local-working-missing', status: 'working', local: true, exists: false, stale: false },
    { id: 'remote-offline-missing-here', status: 'offline', local: false, exists: false, stale: false },
  ] as const;

  assert.deepEqual(
    staleMissingRepoAgentIds(cases, (row) => row.local, (row) => row.exists),
    cases.filter((row) => row.stale).map((row) => row.id),
  );
});

test('workflow choices keep live and queueable offline cartridges but hide dismissed ones', () => {
  const cases = [
    { id: 'working', status: 'working', dismissedAt: '', visible: true },
    { id: 'idle', status: 'idle', dismissedAt: '', visible: true },
    { id: 'offline-valid', status: 'offline', dismissedAt: '', visible: true },
    { id: 'dismissed-live', status: 'working', dismissedAt: '2026-09-16T00:00:00Z', visible: false },
    { id: 'dismissed-offline', status: 'offline', dismissedAt: '2026-09-16T00:00:00Z', visible: false },
  ];

  assert.deepEqual(
    workflowAgentOptions(cases).map((row) => row.id),
    cases.filter((row) => row.visible).map((row) => row.id),
  );
});

test('every workflow cartridge selector uses the shared visibility policy', () => {
  const root = new URL('../../dashboard/src/components/', import.meta.url);
  const surfaces = ['WorkflowPanel.tsx', 'WorkflowCanvasEditor.tsx'];
  for (const file of surfaces) {
    const source = readFileSync(fileURLToPath(new URL(file, root)), 'utf8');
    assert.match(source, /workflowAgentOptions\(/, `${file} bypasses workflowAgentOptions`);
  }
});

test('the scheduled cleanup invokes missing-repository pruning every six hours', () => {
  const source = readFileSync(fileURLToPath(
    new URL('../src/lib/cleanup-scheduler.ts', import.meta.url),
  ), 'utf8');
  assert.match(source, /staleMissingRepoAgentIds\(/);
  assert.match(source, /setInterval\(runCleanup, SIX_HOURS_MS\)/);
});

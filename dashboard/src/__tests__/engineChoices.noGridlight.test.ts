import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SELECTABLE_ENGINES } from '@neoncore/client';

/**
 * REQUESTED: "let's remove the gridlight option in the choices of AI to connect to. I don't want
 * to use it anymore."
 *
 * Every place a person picks an engine offers what SELECTABLE_ENGINES lists — and Gridlight is not
 * in it. Gridlight stays a known agent type, so cartridges and history that already carry it still
 * render; it is only no longer offered. THE SET is every engine picker in the web and phone apps.
 */
const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const PICKERS = [
  'dashboard/src/components/MachineLauncher.tsx',      // launch a cartridge on a machine
  'dashboard/src/components/NewRepoModal.tsx',         // New Repo → which tool to start
  'dashboard/src/components/WorkflowCanvasEditor.tsx', // a workflow step's engine
  'mobile/src/components/NewRepoModal.tsx',            // New Repo, on the phone
  'mobile/src/components/RemoteLaunchModal.tsx',       // remote launch, on the phone
];
// How each picker spelled a Gridlight choice before.
const GRIDLIGHT_CHOICE = /key:\s*'gridlight'|value:\s*'gridlight-cli'|<option value="gridlight"|\[\s*'claude',\s*'gridlight'/;

describe('Gridlight is not offered as an engine', () => {
  it('the shared list of selectable engines leaves it out', () => {
    expect([...SELECTABLE_ENGINES]).toEqual(['claude', 'codex']);
  });

  for (const file of PICKERS) {
    it(file, () => {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      expect(src, `${file} still offers Gridlight`).not.toMatch(GRIDLIGHT_CHOICE);
      expect(src, `${file} does not build its choices from SELECTABLE_ENGINES`).toMatch(/SELECTABLE_ENGINES/);
    });
  }

  it('the Agents type filter no longer forces a Gridlight chip', () => {
    const src = fs.readFileSync(path.join(ROOT, 'dashboard/src/App.tsx'), 'utf8');
    expect(src).not.toMatch(/t === 'gridlight' \|\|/);
  });
});

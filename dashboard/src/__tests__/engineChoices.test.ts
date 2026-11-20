import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SELECTABLE_ENGINES, ENGINE_NAME } from '@neoncore/client';
import { ENGINES, ENGINE_COLOURS } from '../world/crew';
import { ENGINE_LABEL } from '../components/pilotStyles';

/**
 * THE ENGINE SET IS EXACTLY claude + codex.
 *
 * Every list a person picks an engine from, or that labels/colours one, is checked against the
 * same set — not one list in isolation. An engine added to one of them and not the others
 * (or a retired one left behind in one of them) fails here.
 */
const EXPECTED = ['claude', 'codex'];
const sorted = (xs: Iterable<string>) => [...xs].sort();

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const PICKERS = [
  'dashboard/src/components/MachineLauncher.tsx',      // launch a cartridge on a machine
  'dashboard/src/components/NewRepoModal.tsx',         // New Repo → which tool to start
  'dashboard/src/components/WorkflowCanvasEditor.tsx', // a workflow step's engine
  'mobile/src/components/NewRepoModal.tsx',            // New Repo, on the phone
  'mobile/src/components/RemoteLaunchModal.tsx',       // remote launch, on the phone
];

describe('the engine set is exactly claude + codex', () => {
  const lists: [string, Iterable<string>][] = [
    ['SELECTABLE_ENGINES', SELECTABLE_ENGINES],
    ['ENGINE_NAME keys', Object.keys(ENGINE_NAME)],
    ['crew ENGINES', ENGINES],
    ['ENGINE_COLOURS keys', Object.keys(ENGINE_COLOURS)],
    ['pilot ENGINE_LABEL keys', Object.keys(ENGINE_LABEL)],
  ];
  for (const [name, list] of lists) {
    it(name, () => {
      expect(sorted(list)).toEqual(sorted(EXPECTED));
    });
  }

  it('the Agents type filter orders exactly the engine set', () => {
    const src = fs.readFileSync(path.join(ROOT, 'dashboard/src/App.tsx'), 'utf8');
    const m = src.match(/TYPE_ORDER: AgentType\[\] = \[([^\]]*)\]/);
    expect(m, 'TYPE_ORDER not found in App.tsx').toBeTruthy();
    const listed = [...m![1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
    expect(sorted(listed)).toEqual(sorted(EXPECTED));
  });

  for (const file of PICKERS) {
    it(`${file} builds its choices from SELECTABLE_ENGINES`, () => {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      expect(src).toMatch(/SELECTABLE_ENGINES/);
    });
  }
});

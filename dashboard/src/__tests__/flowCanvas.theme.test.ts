import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { canvasEngineerAnim } from '../world/bridge/deckState';

const HERE = dirname(fileURLToPath(import.meta.url));
const editor = readFileSync(resolve(HERE, '../components/WorkflowCanvasEditor.tsx'), 'utf8');
const css = readFileSync(resolve(HERE, '../index.css'), 'utf8');

/**
 * THE WORKFLOW CANVAS AS THE ENGINE DECK'S SCHEMATIC TABLE.
 *
 * The editor's behaviour is untouched; its look is the console look of the other decks,
 * applied through `.bridge.flow-canvas` in index.css. These checks hold the wiring between
 * the two files: a hook the CSS needs that the editor stops emitting would otherwise fail
 * silently, as a canvas that quietly goes back to looking like every other modal.
 */
describe('workflow canvas theme', () => {
  const statuses = [...editor.split('const STATUS_STYLES')[1].split('};')[0].matchAll(/^\s+([a-z]+): \{/gm)].map((m) => m[1]);
  const types = [...editor.split('const TYPE_FRAME')[1].split('};')[0].matchAll(/^\s+'?([a-z-]+)'?: '/gm)].map((m) => m[1]);

  it('reads the step statuses and step types out of the editor (an empty scan would assert nothing)', () => {
    expect(statuses).toEqual(expect.arrayContaining(['pending', 'running', 'completed', 'failed', 'skipped']));
    expect(types).toEqual(expect.arrayContaining(['decision', 'confer']));
  });

  it('the editor opens inside the console scope and marks what the theme styles', () => {
    for (const hook of ['bridge flow-canvas', 'flow-toolbar', 'flow-readout', 'flow-node', 'data-status={data.status}', 'data-kind={', 'flow-engineer']) {
      expect(editor, `the editor no longer emits "${hook}"`).toContain(hook);
    }
  });

  it.each(statuses.map((s) => ({ s })))('a $s step has its own lamp and frame', ({ s }) => {
    expect(css).toContain(`.bridge.flow-canvas .flow-node[data-status="${s}"]`);
  });

  it.each(types.map((t) => ({ t })))('a $t step is framed as its own kind of module', ({ t }) => {
    expect(css).toContain(`.bridge.flow-canvas .flow-node[data-kind="${t}"]`);
  });

  it('conduits, the radar scope, the zoom keys and the blueprint grid are themed', () => {
    for (const sel of ['.react-flow__edge-path', '.react-flow__edge.animated', '.react-flow__minimap', '.react-flow__controls', '.react-flow__handle']) {
      expect(css, sel).toContain(`.bridge.flow-canvas ${sel}`);
    }
    expect(editor).toContain('BackgroundVariant.Lines');
  });

  it('the engineer at the table has one look per state — for every workflow status and step status', () => {
    const WORKFLOW = ['pending', 'running', 'paused', 'completed', 'failed', 'cancelled'];
    for (const wf of WORKFLOW) for (const step of statuses) {
      const anim = canvasEngineerAnim(wf, [step]);
      const live = wf === 'running' || wf === 'paused';
      // A live run that is paused or has a failed step wants you; a running step is work; else he stands by.
      const want = live && (wf === 'paused' || step === 'failed') ? 'call' : live && step === 'running' ? 'work' : 'idle';
      expect(anim, `${wf}/${step}`).toBe(want);
    }
    expect(canvasEngineerAnim('running', [])).toBe('idle');
  });
});

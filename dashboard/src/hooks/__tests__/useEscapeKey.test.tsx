import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { useEscapeKey } from '../useEscapeKey';

function Dialog({ name, onClosed, children }: { name: string; onClosed: (n: string) => void; children?: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  useEscapeKey(() => { setOpen(false); onClosed(name); }, open);
  return open ? <div>{name}{children}</div> : null;
}

describe('useEscapeKey', () => {
  it('closes only the most recently opened dialog, then the one under it', () => {
    const closed: string[] = [];
    const view = render(<Dialog name="outer" onClosed={(n) => closed.push(n)}><Dialog name="inner" onClosed={(n) => closed.push(n)} /></Dialog>);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(closed).toEqual(['inner']);
    expect(view.queryByText('inner')).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(closed).toEqual(['inner', 'outer']);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(closed).toHaveLength(2);
  });

  it('ignores other keys', () => {
    const closed: string[] = [];
    render(<Dialog name="d" onClosed={(n) => closed.push(n)} />);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(closed).toEqual([]);
  });
});

/**
 * Set-based: every full-screen dialog in the dashboard closes on Escape. A backdrop is the marker
 * (`fixed inset-0` with a dimmed background); a component that draws one must use the hook or
 * handle the key itself. Half the dialogs ignoring Escape is how this was found.
 */
describe('every dialog closes on Escape', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '../../components');
  const files = readdirSync(dir).filter((f) => f.endsWith('.tsx'));
  const dialogs = files.filter((f) => /fixed inset-0[^"]*bg-black/.test(readFileSync(join(dir, f), 'utf8')));
  it('finds the dialogs', () => { expect(dialogs.length).toBeGreaterThan(8); });
  it.each(dialogs)('%s', (f) => {
    const src = readFileSync(join(dir, f), 'utf8');
    expect(/useEscapeKey\(|'Escape'/.test(src), `${f} draws a dialog that Escape does not close`).toBe(true);
  });
});

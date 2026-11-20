import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';

const answer = vi.hoisted(() => ({ text: '' }));
vi.mock('../../lib/api', () => ({ api: { getFinalAnswer: () => Promise.resolve({ text: answer.text, complete: true, sessionId: 's', at: '2026-11-19T12:00:00Z' }) } }));

import { FinalAnswerModal } from '../FinalAnswerModal';

afterEach(cleanup);

/**
 * A LONG ANSWER MUST BE READABLE TO ITS LAST LINE. The dialog is capped to the window, so its
 * body is the part that scrolls: it has to be allowed to shrink (min-h-0) and to take the room
 * left under the header (flex-1), or the text simply runs off the bottom of the box. And it is
 * read over the map, so it is see-through to the same degree as the agent's own card.
 */
describe('FinalAnswerModal', () => {
  it.each([1, 40, 400])('with %i paragraphs: the whole answer is in a scrolling body inside a height-capped, see-through dialog', async (n) => {
    answer.text = Array.from({ length: n }, (_, i) => `Paragraph ${i + 1} of the answer.`).join('\n\n');
    render(<FinalAnswerModal agentId="a1" name="neoncore" onClose={() => {}} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const dialog = screen.getByRole('dialog');
    const box = dialog.firstElementChild as HTMLElement;
    const body = box.querySelector<HTMLElement>('[data-answer-body]')!;
    // Every paragraph is rendered — none dropped, none truncated.
    expect(body.querySelectorAll('p')).toHaveLength(n);
    expect(body.textContent).toContain(`Paragraph ${n} of the answer.`);
    // The box is capped and clips; the body takes the rest and scrolls.
    expect(box.className).toMatch(/max-h-\[\d+vh\]/);
    for (const c of ['flex', 'flex-col', 'overflow-hidden']) expect(box.className.split(/\s+/)).toContain(c);
    for (const c of ['flex-1', 'min-h-0', 'overflow-y-auto', 'answer-scroll']) expect(body.className.split(/\s+/), c).toContain(c);
    // The scroller is reachable by keyboard, and the header never scrolls away with the text.
    expect(body.tabIndex).toBe(0);
    expect(body.contains(screen.getByRole('heading'))).toBe(false);
    // 90%, like the agent card over the map — a background alpha, not `opacity`.
    expect(box.style.background).toMatch(/rgba\(10, 16, 32, 0\.9\)/);
    expect(box.style.opacity).toBe('');
  });
});

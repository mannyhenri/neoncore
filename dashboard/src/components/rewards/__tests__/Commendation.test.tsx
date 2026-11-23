import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { CommendationMedal, RankLadder } from '../Commendation';
import { RANKS } from '../../../world/bridge/rank';

afterEach(cleanup);
const NAMES = ["General's Star", "Commander's Cross", "Admiral's Anchor", 'Presidential Medal', 'Order of the Fleet'];

describe('the commendation', () => {
  it.each(NAMES.flatMap((name, tier) => [true, false].map((earned) => ({ name, tier, earned }))))('$name, earned $earned: a laurel wreath, a red ribbon, the explorer statue, its threshold and name', ({ name, tier, earned }) => {
    const threshold = [1, 2, 3, 4, 10][tier];
    const { container } = render(<CommendationMedal tier={tier} threshold={threshold} earned={earned} name={name} label={`Atlas — ${name}`} />);
    const m = container.querySelector('[data-commendation]')!;
    expect(m.getAttribute('data-earned')).toBe(String(earned));
    expect(m.querySelector('[data-laurel]')).not.toBeNull();
    expect(m.querySelectorAll('[data-laurel] path').length).toBeGreaterThanOrEqual(14);
    expect(m.querySelector('[data-ribbon]')).not.toBeNull();
    expect(m.querySelector('img')!.getAttribute('src')).toMatch(/\/kit\/statue\.png$/);
    expect(m.textContent).toContain(String(threshold));
    expect(m.getAttribute('title')).toContain(name);
    expect(m.getAttribute('aria-label')).toBe(`Atlas — ${name}${earned ? '' : ' — not earned yet'}`);
  });

  it.each(RANKS.map((r, index) => ({ title: r.title, index })))('the ladder at $title: every rank in order, this one lit, those below ticked', ({ index }) => {
    const { container } = render(<RankLadder rank={{ index, id: RANKS[index].id, title: RANKS[index].title, commendations: index, next: null }} />);
    const steps = [...container.querySelectorAll('[data-rank-step]')];
    expect(steps.map((s) => s.getAttribute('data-rank-step'))).toEqual(RANKS.map((r) => r.id));
    expect(steps.map((s) => s.hasAttribute('data-current'))).toEqual(RANKS.map((_, i) => i === index));
    expect(steps.map((s) => s.hasAttribute('data-passed'))).toEqual(RANKS.map((_, i) => i < index));
  });
});

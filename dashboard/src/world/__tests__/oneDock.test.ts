import { describe, it, expect } from 'vitest';
import { OUTPOST } from '../sites';

/**
 * REQUESTED: "could we remove the second dock for the machine we're no longer connecting to since
 * now it's going to be only local". Servers are no longer linked, so the map has ONE landing pad —
 * this machine's. The set is every pad structure and every shuttle that lands on one.
 */
describe('the landing field', () => {
  const pads = OUTPOST.structures.filter((st) => st.sprite === 'pad');
  it('has exactly one dock', () => {
    expect(pads.map((p) => p.id)).toEqual(['pad-north']);
  });
  it('every shuttle lands on a dock that exists', () => {
    const shuttles = OUTPOST.structures.filter((st) => st.when === 'in-service');
    expect(shuttles.length).toBeGreaterThan(0);
    for (const s of shuttles) expect(pads.map((p) => p.id), `${s.id} lands on ${s.on}`).toContain(s.on);
  });
});

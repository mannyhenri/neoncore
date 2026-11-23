/**
 * A DRAGGED SPOT HOLDS ONLY WHILE THE PLAN IT WAS DRAGGED IN HOLDS.
 *
 * A pod holds four (zones.ts): when a project grows past that, some of its agents are planned into
 * a second district. A spot you dragged an agent to before that kept pinning it in the first one —
 * on 2026-11-21 Gridlight's four main cartridges, planned into the Survey district, stayed piled on
 * the Greenhouse district's four worktree cartridges after every restart (the spots live in the
 * browser), with the second district standing empty.
 *
 * SET-BASED: every district of every plate.
 */
import { describe, expect, it } from 'vitest';
import { PLATES } from '../sites';
import { spotDistrict, spotHolds, spotStranded } from '../customSpots';

for (const plate of PLATES) {
  const placed = plate.districts.filter((d) => d.x !== undefined && d.y !== undefined);

  describe(`${plate.id}: dragged spots`, () => {
    it('has districts to check', () => {
      expect(placed.length).toBeGreaterThanOrEqual(4);
    });

    for (const d of placed) {
      const atCentre = { x: d.x!, y: d.y! };

      it(`a spot in ${d.id} is in ${d.id}`, () => {
        expect(spotDistrict(atCentre, plate)).toBe(d.id);
      });

      it(`an old spot in ${d.id} holds while the agent is planned for ${d.id}, and not once it is planned elsewhere`, () => {
        expect(spotHolds(atCentre, d.id, plate)).toBe(true);
        for (const other of placed.filter((o) => o.id !== d.id)) {
          expect(spotHolds(atCentre, other.id, plate)).toBe(false);
        }
      });

      it(`a spot dragged while planned for ${d.id} holds wherever it was dropped, while that plan holds`, () => {
        for (const other of placed) {
          const dropped = { x: other.x!, y: other.y!, pod: d.id };
          expect(spotHolds(dropped, d.id, plate)).toBe(true);
          if (other.id !== d.id) expect(spotHolds({ x: d.x!, y: d.y!, pod: other.id }, d.id, plate)).toBe(false);
        }
      });
    }

    it('a spot on open ground, or an agent with no district, always holds', () => {
      const corner = { x: 0.99, y: 0.99 };
      expect(spotDistrict(corner, plate)).toBeUndefined();
      for (const d of placed) expect(spotHolds(corner, d.id, plate)).toBe(true);
      expect(spotHolds({ x: placed[0].x!, y: placed[0].y! }, undefined, plate)).toBe(true);
    });

    it('stranded: only a spot on open ground, with no district recorded, of an agent whose project now has a district', () => {
      const corner = { x: 0.99, y: 0.99 };
      expect(spotStranded(corner, true, plate)).toBe(true);
      // An agent of no project keeps it; so does one that was dropped there while its project had its district.
      expect(spotStranded(corner, false, plate)).toBe(false);
      for (const d of placed) {
        expect(spotStranded({ ...corner, pod: d.id }, true, plate)).toBe(false);
        // A spot inside a district is never stranded: spotHolds decides those.
        expect(spotStranded({ x: d.x!, y: d.y! }, true, plate)).toBe(false);
      }
    });
  });
}

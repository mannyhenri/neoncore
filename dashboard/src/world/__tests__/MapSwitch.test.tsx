import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MapSwitch } from '../MapSwitch';
import { MAPS_BY_THEME, THEMES } from '../theme';

afterEach(cleanup);

/**
 * A MAP IS SEEN ONLY ONCE IT IS EARNED. Set-based over every theme × locked/unlocked × every open
 * map as the current one: a locked map has no button at all, and with only the home map open there
 * is no switch.
 */
const CASES = THEMES.flatMap((theme) => [false, true].flatMap((open) => MAPS_BY_THEME[theme]
  .filter((m) => open || m.requires === undefined)
  .map((cur) => ({ name: `${theme}, ${open ? 'unlocked' : 'locked'}, on ${cur.id}`, theme, open, cur }))));

describe('the map switch', () => {
  it.each(CASES)('$name: only the open maps, the current one marked, a click on another travels', ({ theme, open, cur }) => {
    const maps = MAPS_BY_THEME[theme];
    const onGo = vi.fn();
    const { container } = render(<MapSwitch maps={maps} current={cur.id} unlocked={new Set(open ? ['frontier'] : [])} onGo={onGo} />);
    const openMaps = maps.filter((m) => m.requires === undefined || open);
    if (openMaps.length < 2) {
      // Only the home map: nothing to choose, nothing shown — not even a hint of the locked ones.
      expect(container.innerHTML).toBe('');
      for (const m of maps) expect(container.textContent).not.toContain(m.name);
      return;
    }
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('data-map'))).toEqual(openMaps.map((m) => m.id));
    for (const b of buttons) {
      const id = b.getAttribute('data-map')!;
      expect(b.getAttribute('aria-pressed'), id).toBe(String(id === cur.id));
      expect(b.querySelector('[data-map-says]')!.textContent, id).toBe(id === cur.id ? 'You are here' : 'Travel here');
      fireEvent.click(b);
    }
    expect(onGo.mock.calls.map((c) => c[0])).toEqual(openMaps.filter((m) => m.id !== cur.id).map((m) => m.id));
  });
});

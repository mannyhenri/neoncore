import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { ThemesList } from '../../types';

const calls = vi.hoisted(() => ({ getThemes: vi.fn(), createTheme: vi.fn(), renameTheme: vi.fn(), deleteTheme: vi.fn(), setActiveTheme: vi.fn(), setThemeAsset: vi.fn(), revertThemeAsset: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: calls }));
import { ThemesSettings } from '../ThemesSettings';
import { urlFor } from '../AssetBrowser';
import { assetsFor, groupsOf } from '../../lib/themeCatalog';

const MINE = { id: 'abc12345', name: 'Harbour Night', base: 'scifi', createdAt: 'x', updatedAt: 'x', overrides: { '/world/terrain.jpg': { file: 'f.jpg', bytes: 10, at: '2026-11-23T10:00:00Z' } } };
const LIST = (active = 'scifi'): ThemesList => ({ active, activeBase: 'scifi', builtIn: [{ id: 'scifi', name: 'Neon Outpost', blurb: 'The drawn sci-fi outpost NeonCore ships with.' }, { id: 'fantasy', name: 'Guild Village', blurb: 'The drawn fantasy village.' }], custom: [MINE] } as ThemesList);
beforeEach(() => { for (const f of Object.values(calls)) f.mockReset(); calls.getThemes.mockResolvedValue(LIST()); for (const k of ['createTheme', 'renameTheme', 'setActiveTheme', 'setThemeAsset', 'revertThemeAsset', 'deleteTheme'] as const) calls[k].mockResolvedValue({}); });
afterEach(cleanup);
const card = (id: string) => document.querySelector<HTMLElement>(`[data-theme-card="${id}"]`)!;
const mount = async (props: Parameters<typeof ThemesSettings>[0] = {}) => { render(<ThemesSettings {...props} />); await waitFor(() => expect(card('scifi')).not.toBeNull()); };

describe('Settings → Themes', () => {
  it('every theme a card: built in or yours, which is in use for everyone, and what it offers', async () => {
    await mount();
    expect([...document.querySelectorAll('[data-theme-card]')].map((c) => c.getAttribute('data-theme-card'))).toEqual(['scifi', 'fantasy', 'abc12345']);
    expect(card('scifi').querySelector('[data-badge="built-in"]')).not.toBeNull();
    expect(card('scifi').querySelector('[data-badge="in-use"]')!.textContent).toBe('In use for everyone');
    expect(card('abc12345').querySelector('[data-badge="built-in"]')).toBeNull();
    expect(card('abc12345').textContent).toContain('Based on Neon Outpost · 1 picture or sound replaced');
    const buttons = (id: string) => [...card(id).querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons('scifi')).toEqual(['Browse its assets', 'Duplicate']);
    expect(buttons('fantasy')).toEqual(['Browse its assets', 'Duplicate', 'Use for everyone']);
    expect(buttons('abc12345')).toEqual(['Edit its pictures and sounds', 'Duplicate', 'Use for everyone', 'Rename', 'Delete']);
    // Its preview shows its own map: the replaced one.
    expect(card('abc12345').querySelector('[data-theme-map]')!.getAttribute('src')).toBe(urlFor(MINE as never, '/world/terrain.jpg', 'scifi'));
  });

  it('Duplicate asks for a name, then creates it from that theme; Rename renames; Use for everyone switches and reloads; Delete asks first', async () => {
    const reload = vi.fn();
    await mount({ reload });
    fireEvent.click(card('fantasy').querySelector('[data-theme-duplicate]')!);
    expect((screen.getByLabelText('Name of the new theme') as HTMLInputElement).value).toBe('Guild Village copy');
    fireEvent.change(screen.getByLabelText('Name of the new theme'), { target: { value: 'Elfwood' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(calls.createTheme).toHaveBeenCalledWith({ name: 'Elfwood', from: 'fantasy' }));
    fireEvent.click(card('abc12345').querySelector('[data-theme-rename]')!);
    fireEvent.change(screen.getByLabelText('New name'), { target: { value: 'Harbour Dawn' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(calls.renameTheme).toHaveBeenCalledWith('abc12345', 'Harbour Dawn'));
    fireEvent.click(card('abc12345').querySelector('[data-theme-use]')!);
    await waitFor(() => expect(calls.setActiveTheme).toHaveBeenCalledWith('abc12345'));
    expect(reload).toHaveBeenCalledTimes(1);
    const no = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(card('abc12345').querySelector('[data-theme-delete]')!);
    expect(calls.deleteTheme).not.toHaveBeenCalled();
    no.mockReturnValue(true);
    fireEvent.click(card('abc12345').querySelector('[data-theme-delete]')!);
    await waitFor(() => expect(calls.deleteTheme).toHaveBeenCalledWith('abc12345'));
    no.mockRestore();
  });

  it('browsing a built-in theme: every group with its count, every asset a card — download and the sets, nothing to replace', async () => {
    await mount();
    fireEvent.click(card('scifi').querySelector('[data-theme-browse]')!);
    const groups = groupsOf(assetsFor('scifi'));
    expect([...document.querySelectorAll('[data-asset-group]')].map((g) => g.textContent)).toEqual(groups.map((g) => `${g.group}${g.assets.length}`));
    for (const g of groups) {
      fireEvent.click(document.querySelector(`[data-asset-group="${g.group}"]`)!);
      expect([...document.querySelectorAll('[data-asset]')].map((a) => a.getAttribute('data-asset'))).toEqual(g.assets.map((a) => a.path));
      expect(document.querySelectorAll('[data-asset-file]')).toHaveLength(0);
      for (const a of g.assets) expect(document.querySelector(`[data-asset="${a.path}"] [data-asset-download]`)!.getAttribute('href')).toBe(a.path);
    }
    fireEvent.click(document.querySelector('[data-asset-group="Captain"]')!);
    const first = document.querySelector('[data-asset="/world/bridge/captain.png"]')!;
    fireEvent.click(first.querySelector('[data-asset-show-sets]')!);
    expect([...first.querySelectorAll('[data-asset-set]')].map((s) => s.getAttribute('data-asset-set'))).toEqual(['idle', 'brief', 'call', 'log', 'celebrate', 'worry']);
    fireEvent.click(document.querySelector('[data-asset-close]')!);
    expect(document.querySelector('[data-asset-browser]')).toBeNull();
  });

  it('in a theme of yours: a picture is fitted, shown, then kept; the see-through switch refits; a replaced one can be reverted', async () => {
    const prepare = vi.fn(async (_f: File, _a: unknown, size: { w: number; h: number }, see: boolean) => `data:image/png;base64,${btoa(`${size.w}x${size.h}:${see}`)}`);
    await mount({ prepareImage: prepare });
    fireEvent.click(card('abc12345').querySelector('[data-theme-browse]')!);
    fireEvent.click(document.querySelector('[data-asset-group="Captain"]')!);
    const a = document.querySelector<HTMLElement>('[data-asset="/world/bridge/captain.png"]')!;
    const img = a.querySelector<HTMLImageElement>('[data-asset-image]')!;
    Object.defineProperty(img, 'naturalWidth', { value: 896 }); Object.defineProperty(img, 'naturalHeight', { value: 1920 });
    fireEvent.load(img);
    expect(a.querySelector('[data-asset-size]')!.textContent).toBe('896 × 1920 · 4 × 6 frames of 224 × 320');
    fireEvent.change(a.querySelector('[data-asset-file]')!, { target: { files: [new File(['x'], 'mine.png', { type: 'image/png' })] } });
    await waitFor(() => expect(a.querySelector('[data-asset-pending]')).not.toBeNull());
    expect(prepare).toHaveBeenLastCalledWith(expect.any(File), expect.objectContaining({ path: '/world/bridge/captain.png', fit: 'sheet' }), { w: 896, h: 1920 }, true);
    fireEvent.click(screen.getByLabelText('Make a plain background see-through'));
    await waitFor(() => expect(prepare).toHaveBeenLastCalledWith(expect.any(File), expect.anything(), { w: 896, h: 1920 }, false));
    fireEvent.click(a.querySelector('[data-asset-keep]')!);
    await waitFor(() => expect(calls.setThemeAsset).toHaveBeenCalledWith('abc12345', '/world/bridge/captain.png', btoa('896x1920:false')));
    // The map was replaced before: it can go back.
    fireEvent.click(document.querySelector('[data-asset-group="World map"]')!);
    fireEvent.click(document.querySelector('[data-asset="/world/terrain.jpg"] [data-asset-revert]')!);
    await waitFor(() => expect(calls.revertThemeAsset).toHaveBeenCalledWith('abc12345', '/world/terrain.jpg'));
  });

  it('a sound is kept as it is: no fitting', async () => {
    const prepare = vi.fn();
    await mount({ prepareImage: prepare });
    fireEvent.click(card('abc12345').querySelector('[data-theme-browse]')!);
    fireEvent.click(document.querySelector('[data-asset-group="Sounds"]')!);
    const a = document.querySelector<HTMLElement>('[data-asset="/sound/ui-tap.mp3"]')!;
    fireEvent.change(a.querySelector('[data-asset-file]')!, { target: { files: [new File(['beep'], 'tap.mp3', { type: 'audio/mpeg' })] } });
    await waitFor(() => expect(calls.setThemeAsset).toHaveBeenCalledWith('abc12345', '/sound/ui-tap.mp3', btoa('beep')));
    expect(prepare).not.toHaveBeenCalled();
  });

  it('where an asset is seen: the original, the replacement at its own address when in use, through the theme\'s files when not', () => {
    expect(urlFor(null, '/world/terrain.jpg', 'scifi')).toBe('/world/terrain.jpg');
    expect(urlFor(MINE as never, '/sound/ui-tap.mp3', 'scifi')).toBe('/sound/ui-tap.mp3');
    expect(urlFor(MINE as never, '/world/terrain.jpg', 'abc12345')).toBe('/world/terrain.jpg?v=2026-11-23T10%3A00%3A00Z');
    expect(urlFor(MINE as never, '/world/terrain.jpg', 'scifi')).toBe('/api/themes/abc12345/files?path=%2Fworld%2Fterrain.jpg&v=2026-11-23T10%3A00%3A00Z');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';

/**
 * The folder browser in Settings → Projects.
 *
 * `/api/repos/browse` returns `dirs` as bare NAMES, and resolves whatever it is given with
 * `path.resolve()` — which is relative to the SERVER PROCESS's cwd, not to the folder you
 * are looking at. So requesting a bare "Documents" asks for
 * `<repo>/server/Documents`, gets a 400, and the `.catch(() => {})` swallows it: clicking a
 * folder appeared to do nothing at all, with no error anywhere in the UI.
 *
 * Every browse click must therefore send an ABSOLUTE path built from `current`.
 */

const browseDir = vi.fn();

vi.mock('../../lib/api', () => ({
  api: {
    browseDir: (p?: string) => browseDir(p),
    getSettings: vi.fn().mockResolvedValue({ projects_dir: '' }),
    getToolsStatus: vi.fn().mockResolvedValue({}),
    getGithubAccounts: vi.fn().mockResolvedValue({ accounts: [] }),
    updateSettings: vi.fn().mockResolvedValue({}),
  },
}));

import { SettingsModal } from '../SettingsModal';

const HOME = '/Users/manny';
const CHILDREN = ['code', 'Documents', 'Downloads'];

beforeEach(() => {
  browseDir.mockReset();
  browseDir.mockResolvedValue({ current: HOME, parent: '/Users', dirs: CHILDREN });
});

describe('Settings → Projects folder browser', () => {
  it('sends an absolute path when you click into a folder', async () => {
    const { findByText } = render(<SettingsModal onClose={() => {}} />);

    const documents = await findByText('Documents');
    browseDir.mockClear();
    fireEvent.click(documents);

    await waitFor(() => expect(browseDir).toHaveBeenCalled());
    const sent = browseDir.mock.calls[0][0];

    expect(
      sent,
      `clicking a folder sent ${JSON.stringify(sent)} — a bare name resolves against the server's cwd and 400s`,
    ).toBe(`${HOME}/Documents`);
  });

  // Set-based: EVERY child in the listing must navigate, not just the one reported.
  it('every listed folder navigates to its absolute path', async () => {
    const { findByText } = render(<SettingsModal onClose={() => {}} />);
    await findByText('Documents');

    const wrong: string[] = [];
    for (const name of CHILDREN) {
      browseDir.mockClear();
      fireEvent.click(await findByText(name));
      await waitFor(() => expect(browseDir).toHaveBeenCalled());
      const sent = browseDir.mock.calls[0][0];
      if (sent !== `${HOME}/${name}`) wrong.push(`${name} → ${JSON.stringify(sent)}`);
    }

    expect(wrong, `these folders did not navigate correctly: ${wrong.join(', ')}`).toEqual([]);
  });

  it('surfaces an error instead of silently doing nothing when browse fails', async () => {
    const { findByText } = render(<SettingsModal onClose={() => {}} />);
    const documents = await findByText('Documents');

    browseDir.mockRejectedValueOnce(new Error('Path does not exist'));
    fireEvent.click(documents);

    // The silent `.catch(() => {})` is what made this bug invisible for so long.
    await waitFor(async () => {
      expect(await findByText(/could not open|does not exist|cannot read/i)).toBeTruthy();
    });
  });
});

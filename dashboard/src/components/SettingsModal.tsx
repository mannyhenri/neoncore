import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../lib/api';

interface Props {
  onClose: () => void;
}

export function SettingsModal({ onClose }: Props) {
  const [currentPath, setCurrentPath] = useState('');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [dirs, setDirs] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [savedDir, setSavedDir] = useState('');
  const backdropRef = useRef<HTMLDivElement>(null);

  const browse = useCallback((dirPath?: string) => {
    setLoading(true);
    api.browseDir(dirPath)
      .then(({ current, parent, dirs }) => {
        setCurrentPath(current);
        setParentPath(parent);
        setDirs(dirs);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Load saved setting first, then browse to it (or home)
  useEffect(() => {
    api.getSettings().then((settings) => {
      const saved = settings.projects_dir || '';
      setSavedDir(saved);
      browse(saved || undefined);
    }).catch(() => {
      browse();
    });
  }, [browse]);

  const handleSelect = async () => {
    setSaving(true);
    try {
      await api.updateSettings({ projects_dir: currentPath });
      setSavedDir(currentPath);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  };

  const isSelected = currentPath === savedDir && savedDir !== '';

  return (
    <div
      ref={backdropRef}
      onClick={(e) => { if (e.target === backdropRef.current) onClose(); }}
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
    >
      <div className="glass rounded-xl md:rounded-2xl w-full max-w-lg mx-2 md:mx-0 flex flex-col shadow-2xl max-h-[85vh] md:max-h-[75vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 md:px-6 md:py-4 border-b border-white/[0.06]">
          <div>
            <h2 className="text-lg font-semibold text-white">Settings</h2>
            <p className="text-xs text-gray-500 mt-0.5">Select your projects directory</p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl leading-none">&times;</button>
        </div>

        {/* Current path breadcrumb */}
        <div className="px-4 py-2.5 md:px-6 border-b border-white/[0.06] flex items-center gap-2 min-h-[2.5rem]">
          {parentPath && (
            <button
              onClick={() => browse(parentPath)}
              className="text-gray-400 hover:text-white transition-colors shrink-0 p-0.5"
              title="Go up"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          )}
          <span className="text-sm text-gray-300 font-mono truncate">{currentPath}</span>
          {isSelected && (
            <span className="text-xs text-green-400 shrink-0 ml-auto">Current</span>
          )}
        </div>

        {/* Directory list */}
        <div className="flex-1 overflow-y-auto px-2 py-2 md:px-4">
          {loading ? (
            <div className="text-sm text-gray-500 text-center py-6">Loading...</div>
          ) : dirs.length === 0 ? (
            <div className="text-sm text-gray-600 text-center py-6 italic">No subdirectories</div>
          ) : (
            dirs.map((dir) => (
              <button
                key={dir}
                onClick={() => browse(currentPath + '/' + dir)}
                className="w-full text-left text-sm text-gray-300 hover:bg-white/5 hover:text-white px-3 py-2 rounded-lg transition-colors flex items-center gap-2.5"
              >
                <svg className="w-4 h-4 text-gray-500 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" />
                </svg>
                {dir}
              </button>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 md:px-6 md:py-4 border-t border-white/[0.06] flex items-center gap-3">
          <button
            onClick={handleSelect}
            disabled={saving || !currentPath}
            className="text-sm px-4 py-2 gl-gradient hover:opacity-90 text-white rounded-md disabled:opacity-30 transition-colors"
          >
            {saving ? 'Saving...' : 'Select This Directory'}
          </button>
          {saved && <span className="text-xs text-green-400">Saved</span>}
        </div>
      </div>
    </div>
  );
}

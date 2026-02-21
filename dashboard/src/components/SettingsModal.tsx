import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../lib/api';

interface Props {
  onClose: () => void;
}

type SettingsTab = 'projects' | 'api-keys';

export function SettingsModal({ onClose }: Props) {
  const [tab, setTab] = useState<SettingsTab>('projects');
  const [currentPath, setCurrentPath] = useState('');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [dirs, setDirs] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [savedDir, setSavedDir] = useState('');
  const backdropRef = useRef<HTMLDivElement>(null);

  // API key settings
  const [openaiKey, setOpenaiKey] = useState('');
  const [gridlightUrl, setGridlightUrl] = useState('');
  const [openaiModels, setOpenaiModels] = useState('');
  const [gridlightModels, setGridlightModels] = useState('');
  const [apiSaving, setApiSaving] = useState(false);
  const [apiSaved, setApiSaved] = useState(false);

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

  // Load saved settings
  useEffect(() => {
    api.getSettings().then((settings) => {
      const saved = settings.projects_dir || '';
      setSavedDir(saved);
      browse(saved || undefined);
      setOpenaiKey(settings.openai_api_key || '');
      setGridlightUrl(settings.gridlight_gateway_url || '');
      setOpenaiModels(settings.openai_models || 'gpt-4.1,gpt-4.1-mini');
      setGridlightModels(settings.gridlight_models || '');
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

  const handleSaveApiKeys = async () => {
    setApiSaving(true);
    try {
      await api.updateSettings({
        openai_api_key: openaiKey,
        gridlight_gateway_url: gridlightUrl,
        openai_models: openaiModels,
        gridlight_models: gridlightModels,
      });
      setApiSaved(true);
      setTimeout(() => setApiSaved(false), 2000);
    } catch {
      // ignore
    } finally {
      setApiSaving(false);
    }
  };

  const tabClass = (t: SettingsTab) =>
    `px-3 py-1.5 text-xs font-medium transition-colors rounded-md ${
      tab === t
        ? 'bg-white/10 text-white'
        : 'text-gray-500 hover:text-gray-300 hover:bg-white/5'
    }`;

  return (
    <div
      ref={backdropRef}
      onClick={(e) => { if (e.target === backdropRef.current) onClose(); }}
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
    >
      <div className="glass rounded-xl md:rounded-2xl w-full max-w-lg mx-2 md:mx-0 flex flex-col shadow-2xl max-h-[85vh] md:max-h-[75vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 md:px-6 md:py-4 border-b border-white/[0.06]">
          <div className="flex items-center gap-4">
            <h2 className="text-lg font-semibold text-white">Settings</h2>
            <div className="flex gap-1">
              <button onClick={() => setTab('projects')} className={tabClass('projects')}>Projects</button>
              <button onClick={() => setTab('api-keys')} className={tabClass('api-keys')}>API Keys</button>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl leading-none">&times;</button>
        </div>

        {tab === 'projects' ? (
          <>
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
          </>
        ) : (
          <>
            {/* API Keys tab */}
            <div className="flex-1 overflow-y-auto px-4 py-4 md:px-6 space-y-5">
              {/* OpenAI */}
              <div>
                <h3 className="text-sm font-semibold text-gray-300 mb-3">OpenAI</h3>
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">API Key</label>
                    <input
                      type="password"
                      value={openaiKey}
                      onChange={(e) => setOpenaiKey(e.target.value)}
                      placeholder="sk-..."
                      className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 font-mono placeholder-gray-600 focus:outline-none focus:border-gl-purple"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Models (comma-separated)</label>
                    <input
                      type="text"
                      value={openaiModels}
                      onChange={(e) => setOpenaiModels(e.target.value)}
                      placeholder="gpt-4.1, gpt-4.1-mini"
                      className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 font-mono placeholder-gray-600 focus:outline-none focus:border-gl-purple"
                    />
                  </div>
                </div>
              </div>

              {/* GridLight Gateway */}
              <div>
                <h3 className="text-sm font-semibold text-gray-300 mb-3">GridLight Gateway</h3>
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Gateway URL</label>
                    <input
                      type="text"
                      value={gridlightUrl}
                      onChange={(e) => setGridlightUrl(e.target.value)}
                      placeholder="http://localhost:8080"
                      className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 font-mono placeholder-gray-600 focus:outline-none focus:border-gl-purple"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Models (comma-separated)</label>
                    <input
                      type="text"
                      value={gridlightModels}
                      onChange={(e) => setGridlightModels(e.target.value)}
                      placeholder="llama-3, mistral, sdxl, flux"
                      className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 font-mono placeholder-gray-600 focus:outline-none focus:border-gl-purple"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="px-4 py-3 md:px-6 md:py-4 border-t border-white/[0.06] flex items-center gap-3">
              <button
                onClick={handleSaveApiKeys}
                disabled={apiSaving}
                className="text-sm px-4 py-2 gl-gradient hover:opacity-90 text-white rounded-md disabled:opacity-30 transition-colors"
              >
                {apiSaving ? 'Saving...' : 'Save'}
              </button>
              {apiSaved && <span className="text-xs text-green-400">Saved</span>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

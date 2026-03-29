import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../lib/api';
import { friendlyTool, getServerCapabilityPreview } from '../lib/mcp-tools';
import type { McpServer } from '../types';

interface Props {
  onClose: () => void;
}

type SettingsTab = 'projects' | 'api-keys' | 'mcp-servers';

export function SettingsModal({ onClose }: Props) {
  const [tab, setTab] = useState<SettingsTab>('projects');
  const [currentPath, setCurrentPath] = useState('');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [dirs, setDirs] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [savedDirs, setSavedDirs] = useState<string[]>([]);
  const backdropRef = useRef<HTMLDivElement>(null);

  // API key settings
  const [openaiKey, setOpenaiKey] = useState('');
  const [gridlightUrl, setGridlightUrl] = useState('');
  const [openaiModels, setOpenaiModels] = useState('');
  const [gridlightModels, setGridlightModels] = useState('');
  const [apiSaving, setApiSaving] = useState(false);
  const [apiSaved, setApiSaved] = useState(false);

  // MCP servers
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpEditing, setMcpEditing] = useState<Record<string, Record<string, string>>>({});
  const [customCommand, setCustomCommand] = useState('');
  const [customName, setCustomName] = useState('');
  const [mcpBusy, setMcpBusy] = useState<Set<string>>(new Set());
  const [mcpExpanded, setMcpExpanded] = useState<Set<string>>(new Set());
  const [mcpToolsOpen, setMcpToolsOpen] = useState<Set<string>>(new Set());

  const toggleMcpTools = (id: string) => {
    setMcpToolsOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

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
      const raw = settings.projects_dir || '';
      let dirs: string[] = [];
      if (raw.startsWith('[')) {
        try { dirs = JSON.parse(raw); } catch { /* ignore */ }
      } else if (raw) {
        dirs = [raw];
      }
      setSavedDirs(dirs);
      browse(dirs[0] || undefined);
      setOpenaiKey(settings.openai_api_key || '');
      setGridlightUrl(settings.gridlight_gateway_url || '');
      setOpenaiModels(settings.openai_models || 'gpt-4.1,gpt-4.1-mini');
      setGridlightModels(settings.gridlight_models || '');
    }).catch(() => {
      browse();
    });
  }, [browse]);

  const handleAddDir = async () => {
    if (savedDirs.includes(currentPath)) return;
    setSaving(true);
    try {
      const next = [...savedDirs, currentPath];
      await api.updateSettings({ projects_dir: JSON.stringify(next) });
      setSavedDirs(next);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveDir = async (dirToRemove: string) => {
    const next = savedDirs.filter((d) => d !== dirToRemove);
    try {
      await api.updateSettings({ projects_dir: JSON.stringify(next) });
      setSavedDirs(next);
    } catch { /* ignore */ }
  };

  const isAlreadyAdded = savedDirs.includes(currentPath);

  // Load MCP servers when tab opens
  useEffect(() => {
    if (tab !== 'mcp-servers') return;
    setMcpLoading(true);
    api.getMcpServers()
      .then((servers) => {
        setMcpServers(servers);
        const editing: Record<string, Record<string, string>> = {};
        const autoExpand = new Set<string>();
        for (const s of servers) {
          editing[s.id] = { ...s.env };
          // Auto-expand servers with errors or empty required env fields
          const hasEmptyEnv = Object.values(s.env).some((v) => !v);
          if (s.status === 'error' || (hasEmptyEnv && Object.keys(s.env).length > 0)) {
            autoExpand.add(s.id);
          }
        }
        setMcpEditing(editing);
        setMcpExpanded(autoExpand);
      })
      .catch(() => {})
      .finally(() => setMcpLoading(false));
  }, [tab]);

  const toggleMcpExpanded = (id: string) => {
    setMcpExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleMcpEnvChange = (serverId: string, key: string, value: string) => {
    setMcpEditing((prev) => ({
      ...prev,
      [serverId]: { ...prev[serverId], [key]: value },
    }));
  };

  const handleMcpSaveEnv = async (serverId: string) => {
    const env = mcpEditing[serverId];
    if (!env) return;
    setMcpBusy((prev) => new Set(prev).add(serverId));
    try {
      const updated = await api.updateMcpServer(serverId, { env });
      setMcpServers((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    } catch { /* ignore */ }
    setMcpBusy((prev) => { const n = new Set(prev); n.delete(serverId); return n; });
  };

  const handleMcpToggle = async (server: McpServer) => {
    setMcpBusy((prev) => new Set(prev).add(server.id));
    try {
      // Save env first if changed
      const env = mcpEditing[server.id];
      if (env) await api.updateMcpServer(server.id, { env });

      const updated = server.status === 'running'
        ? await api.stopMcpServer(server.id)
        : await api.startMcpServer(server.id);
      setMcpServers((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    } catch { /* ignore */ }
    setMcpBusy((prev) => { const n = new Set(prev); n.delete(server.id); return n; });
  };

  const handleAddCustomMcp = async () => {
    if (!customCommand.trim()) return;
    try {
      const server = await api.addMcpServer({ command: customCommand.trim(), name: customName.trim() || undefined });
      setMcpServers((prev) => [...prev, server]);
      setMcpEditing((prev) => ({ ...prev, [server.id]: { ...server.env } }));
      setCustomCommand('');
      setCustomName('');
    } catch { /* ignore */ }
  };

  const handleDeleteMcp = async (id: string) => {
    try {
      await api.deleteMcpServer(id);
      setMcpServers((prev) => prev.filter((s) => s.id !== id));
    } catch { /* ignore */ }
  };

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
              <button onClick={() => setTab('mcp-servers')} className={tabClass('mcp-servers')}>MCP Servers</button>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl leading-none">&times;</button>
        </div>

        {tab === 'projects' ? (
          <>
            {/* Saved directories list */}
            {savedDirs.length > 0 && (
              <div className="px-4 py-2.5 md:px-6 border-b border-white/[0.06] space-y-1">
                <span className="text-[13px] text-gray-500 uppercase tracking-wider">Watched Directories</span>
                {savedDirs.map((dir) => (
                  <div key={dir} className="flex items-center gap-2 group">
                    <span className="w-1.5 h-1.5 rounded-full bg-gl-purple shrink-0" />
                    <span className="text-xs text-gray-300 font-mono truncate flex-1">{dir}</span>
                    <button
                      onClick={() => handleRemoveDir(dir)}
                      className="text-gray-600 hover:text-red-400 text-xs opacity-0 group-hover:opacity-100 transition-all shrink-0"
                      title="Remove"
                    >&times;</button>
                  </div>
                ))}
              </div>
            )}

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
              {isAlreadyAdded && (
                <span className="text-xs text-green-400 shrink-0 ml-auto">Added</span>
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
                onClick={handleAddDir}
                disabled={saving || !currentPath || isAlreadyAdded}
                className="text-sm px-4 py-2 gl-gradient hover:opacity-90 text-white rounded-md disabled:opacity-30 transition-colors"
              >
                {saving ? 'Saving...' : isAlreadyAdded ? 'Already Added' : 'Add This Directory'}
              </button>
              {saved && <span className="text-xs text-green-400">Added</span>}
            </div>
          </>
        ) : tab === 'api-keys' ? (
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
        ) : tab === 'mcp-servers' ? (
          <>
            {/* MCP Servers tab */}
            <div className="flex-1 overflow-y-auto px-4 py-4 md:px-6 space-y-4">
              {mcpLoading ? (
                <div className="text-sm text-gray-500 text-center py-6">Loading MCP servers...</div>
              ) : (
                <>
                  {/* Pre-configured servers */}
                  <div className="space-y-2">
                    {mcpServers.filter((s) => s.isPreconfigured).map((server) => {
                      const envKeys = Object.keys(server.env);
                      const busy = mcpBusy.has(server.id);
                      const expanded = mcpExpanded.has(server.id);
                      const statusColor = server.status === 'running' ? 'bg-green-500' : server.status === 'error' ? 'bg-red-500' : 'bg-gray-600';
                      return (
                        <div key={server.id} className="glass-light rounded-lg overflow-hidden">
                          <div className="flex items-center justify-between p-3">
                            <button
                              onClick={() => toggleMcpExpanded(server.id)}
                              className="flex items-center gap-2 min-w-0 flex-1 text-left"
                            >
                              <svg
                                className={`w-3 h-3 text-gray-500 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
                                fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"
                              >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                              </svg>
                              <span className={`w-2 h-2 rounded-full shrink-0 ${statusColor}`} />
                              <span className="text-sm font-medium text-white truncate">{server.name}</span>
                              <span className="text-[13px] text-gray-500 shrink-0">{server.status}</span>
                            </button>
                            <div className="flex items-center gap-1 shrink-0 ml-2">
                              <button
                                onClick={() => handleMcpToggle(server)}
                                disabled={busy || (!server.command && server.slug !== 'claude-code')}
                                className={`text-xs px-3 py-1 rounded-md transition-colors ${
                                  server.status === 'running'
                                    ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                                    : 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
                                } disabled:opacity-30`}
                              >
                                {busy ? '...' : server.status === 'running' ? 'Stop' : 'Start'}
                              </button>
                              <button
                                onClick={() => handleDeleteMcp(server.id)}
                                className="text-xs text-gray-500 hover:text-red-400 px-1 transition-colors"
                              >&times;</button>
                            </div>
                          </div>
                          {expanded && (
                            <div className="px-3 pb-3 space-y-2 border-t border-white/[0.04] pt-2">
                              {server.description && (
                                <p className="text-xs text-gray-400">{server.description}</p>
                              )}
                              {server.error && (
                                <div className="text-xs text-red-400 bg-red-500/10 rounded px-2 py-1">{server.error}</div>
                              )}
                              {envKeys.length > 0 && (
                                <div className="space-y-1.5">
                                  {envKeys.map((key) => (
                                    <div key={key}>
                                      <label className="block text-[13px] text-gray-500 mb-0.5">{key}</label>
                                      <input
                                        type={key.toLowerCase().includes('key') || key.toLowerCase().includes('token') || key.toLowerCase().includes('secret') ? 'password' : 'text'}
                                        value={mcpEditing[server.id]?.[key] ?? ''}
                                        onChange={(e) => handleMcpEnvChange(server.id, key, e.target.value)}
                                        onBlur={() => handleMcpSaveEnv(server.id)}
                                        placeholder={key}
                                        className="w-full text-xs glass-input text-gray-300 rounded px-2 py-1.5 font-mono placeholder-gray-600 focus:outline-none focus:border-gl-purple"
                                      />
                                    </div>
                                  ))}
                                </div>
                              )}
                              {server.capabilities.length > 0 && (
                                <div>
                                  <button
                                    onClick={() => toggleMcpTools(server.id)}
                                    className="text-[13px] text-gray-500 hover:text-gray-300 transition-colors flex items-center gap-1"
                                  >
                                    <svg
                                      className={`w-2.5 h-2.5 transition-transform ${mcpToolsOpen.has(server.id) ? 'rotate-90' : ''}`}
                                      fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"
                                    >
                                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                                    </svg>
                                    {server.capabilities.length} tool{server.capabilities.length !== 1 ? 's' : ''} available
                                  </button>
                                  {mcpToolsOpen.has(server.id) && (
                                    <div className="mt-1.5 space-y-1.5 pl-3 border-l border-white/[0.06]">
                                      {server.capabilities.map((tool) => {
                                        const friendly = friendlyTool(tool.name, tool.description);
                                        return (
                                          <div key={tool.name}>
                                            <div className="flex items-baseline gap-1.5">
                                              <span className="text-[13px] text-gray-300 font-medium">{friendly.label}</span>
                                              <span className="text-[13px] text-gray-600 font-mono">{tool.name}</span>
                                            </div>
                                            {friendly.description && (
                                              <p className="text-[13px] text-gray-500 leading-snug">{friendly.description}</p>
                                            )}
                                          </div>
                                        );
                                      })}
                                    </div>
                                  )}
                                </div>
                              )}
                              {server.capabilities.length === 0 && (() => {
                                const preview = getServerCapabilityPreview(server.slug);
                                if (!preview) return null;
                                return (
                                  <div>
                                    <button
                                      onClick={() => toggleMcpTools(server.id)}
                                      className="text-[13px] text-gray-500 hover:text-gray-300 transition-colors flex items-center gap-1"
                                    >
                                      <svg
                                        className={`w-2.5 h-2.5 transition-transform ${mcpToolsOpen.has(server.id) ? 'rotate-90' : ''}`}
                                        fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"
                                      >
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                                      </svg>
                                      What you can do ({preview.length})
                                    </button>
                                    {mcpToolsOpen.has(server.id) && (
                                      <div className="mt-1.5 space-y-1.5 pl-3 border-l border-white/[0.06]">
                                        {preview.map((cap) => (
                                          <div key={cap.label}>
                                            <span className="text-[13px] text-gray-300 font-medium">{cap.label}</span>
                                            <p className="text-[13px] text-gray-500 leading-snug">{cap.description}</p>
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                );
                              })()}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* Custom servers */}
                  {mcpServers.filter((s) => !s.isPreconfigured).length > 0 && (
                    <div className="space-y-2">
                      <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Custom Servers</h3>
                      {mcpServers.filter((s) => !s.isPreconfigured).map((server) => {
                        const busy = mcpBusy.has(server.id);
                        const expanded = mcpExpanded.has(server.id);
                        const statusColor = server.status === 'running' ? 'bg-green-500' : server.status === 'error' ? 'bg-red-500' : 'bg-gray-600';
                        return (
                          <div key={server.id} className="glass-light rounded-lg overflow-hidden">
                            <div className="flex items-center justify-between p-3">
                              <button
                                onClick={() => toggleMcpExpanded(server.id)}
                                className="flex items-center gap-2 min-w-0 flex-1 text-left"
                              >
                                <svg
                                  className={`w-3 h-3 text-gray-500 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
                                  fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"
                                >
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                                </svg>
                                <span className={`w-2 h-2 rounded-full shrink-0 ${statusColor}`} />
                                <span className="text-sm font-medium text-white truncate">{server.name}</span>
                                <span className="text-[13px] text-gray-500 shrink-0">{server.status}</span>
                              </button>
                              <div className="flex items-center gap-1 shrink-0 ml-2">
                                <button
                                  onClick={() => handleMcpToggle(server)}
                                  disabled={busy}
                                  className={`text-xs px-2 py-1 rounded transition-colors ${
                                    server.status === 'running'
                                      ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                                      : 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
                                  } disabled:opacity-30`}
                                >
                                  {busy ? '...' : server.status === 'running' ? 'Stop' : 'Start'}
                                </button>
                                <button
                                  onClick={() => handleDeleteMcp(server.id)}
                                  className="text-xs text-gray-500 hover:text-red-400 px-1 transition-colors"
                                >&times;</button>
                              </div>
                            </div>
                            {expanded && (
                              <div className="px-3 pb-3 border-t border-white/[0.04] pt-2 space-y-1.5">
                                <span className="text-[13px] text-gray-500 font-mono">{server.command} {server.args.join(' ')}</span>
                                {server.description && (
                                  <p className="text-xs text-gray-400">{server.description}</p>
                                )}
                                {server.error && (
                                  <div className="text-xs text-red-400 bg-red-500/10 rounded px-2 py-1">{server.error}</div>
                                )}
                                {server.capabilities.length > 0 && (
                                  <div>
                                    <button
                                      onClick={() => toggleMcpTools(server.id)}
                                      className="text-[13px] text-gray-500 hover:text-gray-300 transition-colors flex items-center gap-1"
                                    >
                                      <svg
                                        className={`w-2.5 h-2.5 transition-transform ${mcpToolsOpen.has(server.id) ? 'rotate-90' : ''}`}
                                        fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"
                                      >
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                                      </svg>
                                      {server.capabilities.length} tool{server.capabilities.length !== 1 ? 's' : ''} available
                                    </button>
                                    {mcpToolsOpen.has(server.id) && (
                                      <div className="mt-1.5 space-y-1.5 pl-3 border-l border-white/[0.06]">
                                        {server.capabilities.map((tool) => {
                                          const friendly = friendlyTool(tool.name, tool.description);
                                          return (
                                          <div key={tool.name}>
                                            <div className="flex items-baseline gap-1.5">
                                              <span className="text-[13px] text-gray-300 font-medium">{friendly.label}</span>
                                              <span className="text-[13px] text-gray-600 font-mono">{tool.name}</span>
                                            </div>
                                            {friendly.description && (
                                              <p className="text-[13px] text-gray-500 leading-snug">{friendly.description}</p>
                                            )}
                                          </div>
                                          );
                                        })}
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Add custom server */}
                  <div className="border-t border-white/[0.06] pt-3 space-y-2">
                    <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Add Custom MCP Server</h3>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={customName}
                        onChange={(e) => setCustomName(e.target.value)}
                        placeholder="Name (optional)"
                        className="w-28 text-xs glass-input text-gray-300 rounded px-2 py-1.5 placeholder-gray-600 focus:outline-none focus:border-gl-purple"
                      />
                      <input
                        type="text"
                        value={customCommand}
                        onChange={(e) => setCustomCommand(e.target.value)}
                        placeholder="npx @some/mcp-server"
                        className="flex-1 text-xs glass-input text-gray-300 rounded px-2 py-1.5 font-mono placeholder-gray-600 focus:outline-none focus:border-gl-purple"
                        onKeyDown={(e) => { if (e.key === 'Enter') handleAddCustomMcp(); }}
                      />
                      <button
                        onClick={handleAddCustomMcp}
                        disabled={!customCommand.trim()}
                        className="text-xs px-3 py-1.5 gl-gradient text-white rounded disabled:opacity-30 hover:opacity-90 transition-colors"
                      >
                        Add
                      </button>
                    </div>
                    <p className="text-[13px] text-gray-600">
                      Paste any npx command from mcp-awesome.com or the MCP server registry
                    </p>
                  </div>
                </>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

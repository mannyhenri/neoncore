import { useState, useEffect } from 'react';
import type { VirtualCartridge, McpServer, McpTool, PinnedTool } from '../types';
import { friendlyTool } from '../lib/mcp-tools';
import { api } from '../lib/api';

interface Props {
  cartridge: VirtualCartridge;
  mcpServers: McpServer[];
  onClose: () => void;
  onSave: (cartridge: VirtualCartridge) => void;
}

export function VirtualCartridgeConfig({ cartridge, mcpServers, onClose, onSave }: Props) {
  const [enabledIds, setEnabledIds] = useState<Set<string>>(new Set(cartridge.mcpServerIds));
  const [pinnedTools, setPinnedTools] = useState<PinnedTool[]>(cartridge.pinnedTools);
  const [name, setName] = useState(cartridge.name);
  const [saving, setSaving] = useState(false);
  const [availableTools, setAvailableTools] = useState<(McpTool & { serverId: string; serverName: string })[]>([]);
  const [loadingTools, setLoadingTools] = useState(false);

  // Load tools from enabled servers
  useEffect(() => {
    if (enabledIds.size === 0) {
      setAvailableTools([]);
      return;
    }
    setLoadingTools(true);
    const fetchTools = async () => {
      const all: (McpTool & { serverId: string; serverName: string })[] = [];
      for (const id of enabledIds) {
        const server = mcpServers.find((s) => s.id === id);
        if (!server || server.status !== 'running') continue;
        try {
          const tools = await api.getMcpTools(id);
          for (const t of tools) {
            all.push({ ...t, serverId: id, serverName: server.name });
          }
        } catch {
          // skip
        }
      }
      setAvailableTools(all);
      setLoadingTools(false);
    };
    fetchTools();
  }, [enabledIds, mcpServers]);

  const toggleServer = (id: string) => {
    setEnabledIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        // Remove pinned tools from this server
        setPinnedTools((pt) => pt.filter((p) => p.serverId !== id));
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const togglePin = (serverId: string, toolName: string) => {
    setPinnedTools((prev) => {
      const exists = prev.find((p) => p.serverId === serverId && p.toolName === toolName);
      if (exists) return prev.filter((p) => p !== exists);
      return [...prev, { serverId, toolName }];
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const updated = await api.updateVirtualCartridge(cartridge.id, {
        name,
        mcpServerIds: [...enabledIds],
        pinnedTools,
      });
      onSave(updated);
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="glass-dark rounded-xl border border-white/10 w-full max-w-lg mx-4 max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
          <h3 className="text-sm font-medium text-gray-200">Configure Virtual Cartridge</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-lg">&times;</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
          {/* Name */}
          <div>
            <label className="text-xs text-gray-400 block mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full glass-input text-sm text-gray-200 rounded-md px-3 py-2 focus:outline-none"
            />
          </div>

          {/* MCP Servers */}
          <div>
            <label className="text-xs text-gray-400 block mb-2">Enabled MCP Servers</label>
            <div className="space-y-1.5">
              {mcpServers.map((server) => (
                <label key={server.id} className="flex items-center gap-2.5 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={enabledIds.has(server.id)}
                    onChange={() => toggleServer(server.id)}
                    className="accent-teal-500"
                  />
                  <span className="text-sm text-gray-300 group-hover:text-white transition-colors flex-1">
                    {server.name}
                  </span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                    server.status === 'running' ? 'bg-green-900/40 text-green-400' : 'bg-gray-800 text-gray-500'
                  }`}>
                    {server.status}
                  </span>
                </label>
              ))}
              {mcpServers.length === 0 && (
                <p className="text-xs text-gray-600 italic">No MCP servers installed — add some from the marketplace</p>
              )}
            </div>
          </div>

          {/* Pin Tools as Action Buttons */}
          {availableTools.length > 0 && (
            <div>
              <label className="text-xs text-gray-400 block mb-2">Pin Tools as Action Buttons</label>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {availableTools.map((tool) => {
                  const isPinned = pinnedTools.some(
                    (p) => p.serverId === tool.serverId && p.toolName === tool.name
                  );
                  const friendly = friendlyTool(tool.name, tool.description);
                  return (
                    <label key={`${tool.serverId}:${tool.name}`} className="flex items-center gap-2.5 cursor-pointer group">
                      <input
                        type="checkbox"
                        checked={isPinned}
                        onChange={() => togglePin(tool.serverId, tool.name)}
                        className="accent-teal-500"
                      />
                      <span className="text-sm text-gray-300 group-hover:text-white transition-colors flex-1 truncate">
                        {friendly.label}
                      </span>
                      <span className="text-[10px] text-gray-600">{tool.serverName}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {loadingTools && enabledIds.size > 0 && (
            <p className="text-xs text-gray-500">Loading tools from running servers...</p>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-white/[0.06] flex justify-end gap-2">
          <button onClick={onClose} className="text-xs px-3 py-1.5 text-gray-400 hover:text-white">Cancel</button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="text-xs px-4 py-1.5 rounded-md bg-teal-500/20 text-teal-400 hover:bg-teal-500/30 border border-teal-500/30 disabled:opacity-40"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

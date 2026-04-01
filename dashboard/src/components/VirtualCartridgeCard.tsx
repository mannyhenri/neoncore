import { useState, useCallback, useEffect, useMemo } from 'react';
import type { VirtualCartridge, McpTool, McpServer } from '../types';
import { VirtualCartridgeConfig } from './VirtualCartridgeConfig';
import { friendlyTool } from '../lib/mcp-tools';
import { generatePixelSprites } from '../lib/sprites';
import { api } from '../lib/api';

interface Props {
  cartridge: VirtualCartridge;
  mcpServers: McpServer[];
  onUpdate: (cartridge: VirtualCartridge) => void;
  onDelete: (id: string) => void;
}

// ---------------------------------------------------------------------------
// Tool execution modal
// ---------------------------------------------------------------------------

function ToolExecuteModal({
  tool,
  serverId,
  cartridgeId,
  onClose,
}: {
  tool: McpTool & { serverId: string; serverName: string };
  serverId: string;
  cartridgeId: string;
  onClose: () => void;
}) {
  const [args, setArgs] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState('');

  const schema = tool.inputSchema as { properties?: Record<string, { type?: string; description?: string }>; required?: string[] };
  const properties = schema?.properties || {};

  const handleRun = async () => {
    setRunning(true);
    setError('');
    setResult(null);
    try {
      const resp = await api.executeVirtualCartridgeTool(cartridgeId, serverId, tool.name, args);
      setResult(resp.result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="glass-dark rounded-xl border border-white/10 w-full max-w-lg mx-4 max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
          <h3 className="text-sm font-medium text-gray-200">{friendlyTool(tool.name, tool.description).label}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-lg">&times;</button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {Object.entries(properties).map(([key, prop]) => (
            <div key={key}>
              <label className="text-xs text-gray-400 block mb-1">
                {key}
                {schema.required?.includes(key) && <span className="text-red-400 ml-0.5">*</span>}
              </label>
              <input
                type="text"
                value={args[key] || ''}
                onChange={(e) => setArgs({ ...args, [key]: e.target.value })}
                placeholder={prop.description || ''}
                className="w-full glass-input text-sm text-gray-200 rounded-md px-3 py-2 focus:outline-none placeholder-gray-600"
              />
            </div>
          ))}

          {Object.keys(properties).length === 0 && (
            <p className="text-xs text-gray-500 italic">This tool takes no arguments</p>
          )}

          {error && (
            <div className="text-xs text-red-400 bg-red-950/30 rounded px-3 py-2">{error}</div>
          )}

          {result !== null && (
            <div className="bg-white/[0.03] rounded-lg p-3">
              <p className="text-[10px] text-gray-500 mb-1">Result</p>
              <pre className="text-xs text-gray-300 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
                {typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-white/[0.06] flex justify-end gap-2">
          <button onClick={onClose} className="text-xs px-3 py-1.5 text-gray-400 hover:text-white">Cancel</button>
          <button
            onClick={handleRun}
            disabled={running}
            className="text-xs px-4 py-1.5 rounded-md bg-teal-500/20 text-teal-400 hover:bg-teal-500/30 border border-teal-500/30 disabled:opacity-40"
          >
            {running ? 'Running...' : 'Execute'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// VirtualCartridgeCard — same visual as CartridgeCard (retro cartridge style)
// ---------------------------------------------------------------------------

export function VirtualCartridgeCard({ cartridge, mcpServers, onUpdate, onDelete }: Props) {
  const [showConfig, setShowConfig] = useState(false);
  const [executingTool, setExecutingTool] = useState<(McpTool & { serverId: string; serverName: string }) | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const dirName = cartridge.directoryPath.split('/').pop() || cartridge.name;
  const enabledServers = mcpServers.filter((s) => cartridge.mcpServerIds.includes(s.id));

  // Sprite animation — same as CartridgeCard
  const [frame1, frame2, animSpeed] = useMemo(() => generatePixelSprites(cartridge.id), [cartridge.id]);
  const [spriteFrame, setSpriteFrame] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setSpriteFrame((f) => (f === 0 ? 1 : 0)), animSpeed);
    return () => clearInterval(id);
  }, [animSpeed]);

  const pixelBg = spriteFrame === 0 ? frame1 : frame2;

  const handleDelete = useCallback(() => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 3000);
      return;
    }
    onDelete(cartridge.id);
  }, [confirmDelete, cartridge.id, onDelete]);

  return (
    <>
      <div className="relative flex flex-col">
        {/* ── Contact strip (top connector) ── */}
        <div
          className="mx-auto w-[60%] h-4 rounded-t-sm relative"
          style={{
            background: 'linear-gradient(180deg, #2a2a3e 0%, #1a1a2e 100%)',
            borderLeft: '1px solid rgba(255,255,255,0.06)',
            borderRight: '1px solid rgba(255,255,255,0.06)',
            borderTop: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          <div className="absolute inset-x-2 top-1 bottom-0 flex justify-between">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="w-[2px] h-full"
                style={{ background: 'rgba(20,184,166,0.35)' }}
              />
            ))}
          </div>
        </div>

        {/* ── Main cartridge body ── */}
        <div
          className="glass rounded-lg border border-white/[0.08] flex flex-col transition-colors"
          style={{ borderTopLeftRadius: '2px', borderTopRightRadius: '2px' }}
        >
          {/* ── Sticker area ── */}
          <div
            className="mx-3 mt-3 mb-2 rounded p-3 relative overflow-hidden"
            style={{
              background: 'linear-gradient(135deg, rgba(20,184,166,0.25) 0%, rgba(6,182,212,0.2) 50%, rgba(59,130,246,0.15) 100%)',
              boxShadow: '0 0 0 2px #14b8a6, 4px 4px 0 0 rgba(0,0,0,0.3)',
              imageRendering: 'pixelated',
            }}
          >
            {/* Pixel art background */}
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                backgroundImage: `url("${pixelBg}")`,
                backgroundSize: 'contain',
                backgroundPosition: 'center',
                backgroundRepeat: 'no-repeat',
                imageRendering: 'pixelated',
                opacity: 0.12,
              }}
            />

            {/* Top row: name + controls */}
            <div className="flex items-start justify-between mb-1.5">
              <h3 className="font-pixel text-xs text-white leading-relaxed tracking-wide truncate flex-1 mr-2">
                {cartridge.name || dirName}
              </h3>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={() => setShowConfig(true)}
                  className="text-gray-400 hover:text-teal-400 transition-colors"
                  title="Configure MCP servers & tools"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.431.992a7.723 7.723 0 0 1 0 .255c-.007.378.138.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                  </svg>
                </button>
                <button
                  onClick={handleDelete}
                  className={`transition-colors text-xs font-bold ${confirmDelete ? 'text-red-400' : 'text-gray-400 hover:text-red-400'}`}
                  title={confirmDelete ? 'Click again to confirm' : 'Remove cartridge'}
                >
                  {confirmDelete ? '!' : 'x'}
                </button>
              </div>
            </div>

            {/* Directory path */}
            <div className="text-[13px] text-gray-300 mb-1 font-mono truncate">
              {cartridge.directoryPath}
            </div>

            {/* Status row */}
            <div className="flex items-center gap-2 mb-1">
              <div className="w-2 h-2 bg-teal-500" style={{ imageRendering: 'pixelated' }} />
              <span className="text-[13px] text-gray-200">Local</span>
            </div>

            {/* Labels: type badge + MCP server badges */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[13px] px-1.5 py-0.5 rounded font-medium tracking-wide bg-teal-900/60 text-teal-300">
                Virtual
              </span>
              {enabledServers.map((s) => (
                <span key={s.id} className="text-[13px] px-1.5 py-0.5 rounded font-medium tracking-wide bg-white/[0.06] text-gray-400">
                  {s.name}
                </span>
              ))}
            </div>
          </div>

          {/* ── Pinned tool action buttons ── */}
          {cartridge.pinnedTools.length > 0 && (
            <div className="mx-3 mb-2 flex flex-wrap gap-1.5">
              {cartridge.pinnedTools.map((pt, i) => {
                const server = mcpServers.find((s) => s.id === pt.serverId);
                return (
                  <button
                    key={i}
                    onClick={() =>
                      setExecutingTool({
                        name: pt.toolName,
                        description: '',
                        inputSchema: {},
                        serverId: pt.serverId,
                        serverName: server?.name || '',
                      })
                    }
                    className="text-[11px] px-2.5 py-1 rounded-md bg-teal-500/10 text-teal-400 hover:bg-teal-500/20 border border-teal-500/20 transition-colors"
                  >
                    {pt.label || friendlyTool(pt.toolName, '').label}
                  </button>
                );
              })}
            </div>
          )}

          {/* ── Empty state ── */}
          {cartridge.mcpServerIds.length === 0 && cartridge.pinnedTools.length === 0 && (
            <div className="mx-3 mb-2">
              <button
                onClick={() => setShowConfig(true)}
                className="w-full text-[11px] text-gray-500 hover:text-teal-400 py-2 border border-dashed border-white/[0.08] rounded transition-colors"
              >
                Configure MCP servers to add capabilities
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Config modal */}
      {showConfig && (
        <VirtualCartridgeConfig
          cartridge={cartridge}
          mcpServers={mcpServers}
          onClose={() => setShowConfig(false)}
          onSave={(updated) => {
            onUpdate(updated);
            setShowConfig(false);
          }}
        />
      )}

      {/* Tool execution modal */}
      {executingTool && (
        <ToolExecuteModal
          tool={executingTool}
          serverId={executingTool.serverId}
          cartridgeId={cartridge.id}
          onClose={() => setExecutingTool(null)}
        />
      )}
    </>
  );
}

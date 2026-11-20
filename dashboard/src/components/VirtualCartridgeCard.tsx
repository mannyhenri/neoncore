import { useState, useCallback } from 'react';
import type { VirtualCartridge } from '../types';
import { VirtualCartridgeConfig } from './VirtualCartridgeConfig';
import { api } from '../lib/api';

interface Props {
  cartridge: VirtualCartridge;
  onUpdate: (cartridge: VirtualCartridge) => void;
  onDelete: (id: string) => void;
}

// ---------------------------------------------------------------------------
// VirtualCartridgeCard — a teal, dashed Night Glass card: a folder you can launch into
// ---------------------------------------------------------------------------

const LAUNCH_OPTIONS: { type: string; label: string }[] = [
  { type: 'claude-terminal', label: 'Claude · Terminal' },
  { type: 'claude',    label: 'Claude · VS Code' },
  { type: 'codex-terminal', label: 'Codex · Terminal' },
  { type: 'codex',    label: 'Codex · VS Code' },
];

export function VirtualCartridgeCard({ cartridge, onUpdate, onDelete }: Props) {
  const [showConfig, setShowConfig] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showLauncher, setShowLauncher] = useState(false);
  const [launching, setLaunching] = useState(false);

  const dirName = cartridge.directoryPath.split('/').pop() || cartridge.name;

  const handleDelete = useCallback(() => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 3000);
      return;
    }
    onDelete(cartridge.id);
  }, [confirmDelete, cartridge.id, onDelete]);

  const handleLaunch = useCallback(async (agentType: string) => {
    setShowLauncher(false);
    setLaunching(true);
    try {
      await api.launchVirtualCartridge(cartridge.id, agentType);
    } catch { /* silent — extension registration confirms success */ }
    setTimeout(() => setLaunching(false), 2000);
  }, [cartridge.id]);

  return (
    <>
      <div className="relative flex flex-col rounded-[18px] p-[18px] gap-3 border border-dashed border-[#2EE6D6]/45 bg-[#2EE6D6]/[0.04]">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-mono text-base font-semibold text-gray-100 truncate">
            {cartridge.name || dirName}
          </h3>
          <span className="text-[12px] font-semibold text-[#7FF5EA] shrink-0">Virtual · Local</span>
        </div>
        <span className="text-[13px] text-gray-400 font-mono truncate" title={cartridge.directoryPath}>
          {cartridge.directoryPath}
        </span>

        {/* Launcher picker */}
        {showLauncher && (
          <div className="flex flex-wrap gap-1.5">
            {LAUNCH_OPTIONS.map((opt) => (
              <button
                key={opt.type}
                onClick={() => handleLaunch(opt.type)}
                className="h-9 px-3 rounded-[9px] border border-[#2EE6D6]/40 bg-[#2EE6D6]/[0.08] text-[12px] font-semibold text-[#BFFAF4] hover:bg-[#2EE6D6]/[0.16] transition-colors"
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setShowLauncher((v) => !v)}
            aria-expanded={showLauncher}
            className={`h-10 px-3.5 rounded-[10px] border border-[#2EE6D6]/55 bg-[#2EE6D6]/[0.12] text-[13px] font-semibold text-[#BFFAF4] hover:bg-[#2EE6D6]/[0.2] transition-colors`}
            title="Launch agent in this directory"
          >
            {launching ? 'Launching…' : `Launch ${showLauncher ? '▴' : '▾'}`}
          </button>
          <button
            onClick={() => setShowConfig(true)}
            className="btn-ghost h-10 px-3.5 rounded-[10px] text-[13px] font-semibold transition-colors"
            title="Configure virtual cartridge"
          >
            Configure
          </button>
          <button
            onClick={handleDelete}
            className={`h-10 px-3.5 rounded-[10px] border text-[13px] font-semibold transition-colors ${
              confirmDelete ? 'border-red-400/60 bg-red-500/10 text-red-200' : 'border-white/[0.14] text-gray-400 hover:text-red-200'
            }`}
            title={confirmDelete ? 'Click again to confirm' : 'Remove cartridge'}
          >
            {confirmDelete ? 'Confirm remove' : 'Remove'}
          </button>
        </div>
      </div>

      {/* Config modal */}
      {showConfig && (
        <VirtualCartridgeConfig
          cartridge={cartridge}
          onClose={() => setShowConfig(false)}
          onSave={(updated) => {
            onUpdate(updated);
            setShowConfig(false);
          }}
        />
      )}
    </>
  );
}

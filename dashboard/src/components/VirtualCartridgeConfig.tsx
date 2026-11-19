import { useState } from 'react';
import type { VirtualCartridge } from '../types';
import { api } from '../lib/api';
import { useEscapeKey } from '../hooks/useEscapeKey';

interface Props {
  cartridge: VirtualCartridge;
  onClose: () => void;
  onSave: (cartridge: VirtualCartridge) => void;
}

export function VirtualCartridgeConfig({ cartridge, onClose, onSave }: Props) {
  useEscapeKey(onClose);
  const [name, setName] = useState(cartridge.name);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const updated = await api.updateVirtualCartridge(cartridge.id, { name });
      onSave(updated);
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="glass-dark rounded-[22px] shadow-[0_30px_80px_rgba(0,0,0,0.6)] w-full max-w-lg mx-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 pt-5 pb-3">
          <h3 className="font-display text-xl font-semibold text-gray-100">Configure Virtual Cartridge</h3>
          <button onClick={onClose} aria-label="Close" className="w-10 h-10 rounded-[10px] border border-white/[0.14] text-gray-300 hover:text-white text-lg">&times;</button>
        </div>

        <div className="px-6 py-3">
          <label className="text-[13px] text-gray-400 block mb-1.5">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full glass-input text-sm text-gray-100 rounded-[10px] h-11 px-3 focus:outline-none"
          />
        </div>

        <div className="px-6 pt-2 pb-5 flex justify-end gap-2">
          <button onClick={onClose} className="btn-ghost h-11 px-4 rounded-[10px] text-sm font-semibold">Cancel</button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="btn-primary h-11 px-5 rounded-[10px] text-sm font-semibold disabled:opacity-40"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

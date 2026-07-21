import { useState } from 'react';
import type { VirtualCartridge } from '../types';
import { api } from '../lib/api';

interface Props {
  cartridge: VirtualCartridge;
  onClose: () => void;
  onSave: (cartridge: VirtualCartridge) => void;
}

export function VirtualCartridgeConfig({ cartridge, onClose, onSave }: Props) {
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="glass-dark rounded-xl border border-white/10 w-full max-w-lg mx-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
          <h3 className="text-sm font-medium text-gray-200">Configure Virtual Cartridge</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-lg">&times;</button>
        </div>

        <div className="px-4 py-4">
          <label className="text-xs text-gray-400 block mb-1">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full glass-input text-sm text-gray-200 rounded-md px-3 py-2 focus:outline-none"
          />
        </div>

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

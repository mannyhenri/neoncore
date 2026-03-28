import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api';
import type { CommandTemplate } from '../types';

interface Props {
  onClose: () => void;
}

export default function CommandTemplatesModal({ onClose }: Props) {
  const [templates, setTemplates] = useState<CommandTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [creating, setCreating] = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);

  const load = () => {
    api.getCommandTemplates()
      .then(setTemplates)
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const categories = [...new Set(templates.map((t) => t.category))].sort();

  const startEdit = (t: CommandTemplate) => {
    setEditingId(t.id);
    setEditName(t.name);
    setEditContent(t.content);
    setEditCategory(t.category);
    setCreating(false);
  };

  const startCreate = () => {
    setCreating(true);
    setEditingId(null);
    setEditName('');
    setEditContent('');
    setEditCategory(categories[0] || 'Custom');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setCreating(false);
  };

  const saveEdit = async () => {
    if (!editName.trim() || !editContent.trim()) return;
    if (creating) {
      await api.createCommandTemplate({ name: editName.trim(), content: editContent.trim(), category: editCategory.trim() || 'Custom' });
    } else if (editingId) {
      await api.updateCommandTemplate(editingId, { name: editName.trim(), content: editContent.trim(), category: editCategory.trim() || 'Custom' });
    }
    cancelEdit();
    load();
  };

  const handleDelete = async (id: string) => {
    await api.deleteCommandTemplate(id);
    if (editingId === id) cancelEdit();
    load();
  };

  // Group templates by category
  const grouped: Record<string, CommandTemplate[]> = {};
  for (const t of templates) {
    (grouped[t.category] ??= []).push(t);
  }

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === backdropRef.current) onClose(); }}
    >
      <div className="bg-[#0d0f12] border border-white/[0.08] rounded-xl shadow-2xl w-[600px] max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
          <h2 className="text-sm font-semibold text-white">Command Templates</h2>
          <div className="flex items-center gap-3">
            <button
              onClick={startCreate}
              className="text-[11px] text-gl-purple hover:text-purple-300 transition-colors"
            >
              + Add New
            </button>
            <button onClick={onClose} className="text-gray-500 hover:text-white text-lg">&times;</button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {/* Create/Edit form */}
          {(creating || editingId) && (
            <div className="border border-white/[0.08] rounded-lg p-3 space-y-2 bg-white/[0.02]">
              <div className="flex gap-2">
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="Command name"
                  className="flex-1 text-xs bg-white/5 border border-white/10 rounded px-2 py-1.5 text-white placeholder-gray-600 focus:outline-none focus:border-gl-purple/50"
                />
                <input
                  value={editCategory}
                  onChange={(e) => setEditCategory(e.target.value)}
                  placeholder="Category"
                  list="template-categories"
                  className="w-32 text-xs bg-white/5 border border-white/10 rounded px-2 py-1.5 text-white placeholder-gray-600 focus:outline-none focus:border-gl-purple/50"
                />
                <datalist id="template-categories">
                  {categories.map((c) => <option key={c} value={c} />)}
                </datalist>
              </div>
              <textarea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                placeholder="Command content (markdown instructions for the AI)..."
                rows={6}
                className="w-full text-xs bg-white/5 border border-white/10 rounded px-2 py-1.5 text-white placeholder-gray-600 focus:outline-none focus:border-gl-purple/50 resize-y font-mono"
              />
              <div className="flex gap-2">
                <button onClick={saveEdit} className="text-[11px] px-3 py-1 gl-gradient text-white rounded hover:opacity-90">
                  {creating ? 'Create' : 'Save'}
                </button>
                <button onClick={cancelEdit} className="text-[11px] px-3 py-1 text-gray-500 hover:text-white">
                  Cancel
                </button>
              </div>
            </div>
          )}

          {loading ? (
            <div className="text-xs text-gray-500 text-center py-8">Loading...</div>
          ) : templates.length === 0 && !creating ? (
            <div className="text-xs text-gray-500 text-center py-8">
              No command templates yet. Click "+ Add New" to create one.
            </div>
          ) : (
            Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)).map(([category, items]) => (
              <div key={category} className="space-y-1">
                <span className="text-[10px] text-gray-500 uppercase tracking-wider">{category}</span>
                {items.map((t) => (
                  <div
                    key={t.id}
                    className={`group flex items-start gap-2 p-2 rounded-lg hover:bg-white/5 cursor-pointer transition-colors ${editingId === t.id ? 'bg-white/5' : ''}`}
                    onClick={() => { if (editingId !== t.id) startEdit(t); }}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-white font-medium">{t.name}</div>
                      <p className="text-[11px] text-gray-500 truncate mt-0.5 font-mono">{t.content.slice(0, 100)}</p>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDelete(t.id); }}
                      className="text-gray-600 hover:text-red-400 text-xs opacity-0 group-hover:opacity-100 transition-all shrink-0 mt-0.5"
                      title="Delete"
                    >
                      &times;
                    </button>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

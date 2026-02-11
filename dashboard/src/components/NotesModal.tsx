import { useState, useEffect, useCallback, useRef } from 'react';
import type { Agent, Note, AgentMemory } from '../types';
import { api } from '../lib/api';

interface Props {
  agent: Agent;
  onClose: () => void;
}

export function NotesModal({ agent, onClose }: Props) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [memories, setMemories] = useState<AgentMemory[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [creating, setCreating] = useState(false);
  const [newContent, setNewContent] = useState('');
  const [showMemoryPicker, setShowMemoryPicker] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const loadNotes = useCallback(() => {
    api.getNotes(agent.id).then(setNotes).catch(() => {});
  }, [agent.id]);

  const loadMemories = useCallback(() => {
    api.getMemory(agent.id).then(setMemories).catch(() => {});
  }, [agent.id]);

  useEffect(() => {
    loadNotes();
    loadMemories();
  }, [loadNotes, loadMemories]);

  // Focus textarea when creating
  useEffect(() => {
    if (creating && textareaRef.current) textareaRef.current.focus();
  }, [creating]);

  const handleCreate = async () => {
    if (!newContent.trim()) return;
    await api.createNote(agent.id, newContent.trim());
    setNewContent('');
    setCreating(false);
    loadNotes();
  };

  const handleUpdate = async (noteId: string) => {
    if (!editContent.trim()) return;
    await api.updateNote(agent.id, noteId, editContent.trim());
    setEditingId(null);
    setEditContent('');
    loadNotes();
  };

  const handleDelete = async (noteId: string) => {
    await api.deleteNote(agent.id, noteId);
    loadNotes();
  };

  const handleCopy = (text: string, noteId: string) => {
    navigator.clipboard.writeText(text);
    setCopied(noteId);
    setTimeout(() => setCopied(null), 1500);
  };

  const insertMemory = (mem: AgentMemory) => {
    const line = `[${mem.category}] ${mem.content}`;
    if (creating) {
      setNewContent((prev) => prev ? `${prev}\n${line}` : line);
    } else if (editingId) {
      setEditContent((prev) => prev ? `${prev}\n${line}` : line);
    }
    setShowMemoryPicker(false);
  };

  const startEdit = (note: Note) => {
    setEditingId(note.id);
    setEditContent(note.content);
    setCreating(false);
  };

  const activeMemories = memories.filter((m) => m.active);

  return (
    <div
      ref={backdropRef}
      onClick={(e) => { if (e.target === backdropRef.current) onClose(); }}
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
    >
      <div className="glass rounded-xl md:rounded-2xl w-full max-w-2xl mx-2 md:mx-0 max-h-[95vh] md:max-h-[85vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 md:px-6 md:py-5 border-b border-white/[0.06]">
          <div>
            <h2 className="text-lg font-semibold text-white">Notes</h2>
            <p className="text-sm text-gray-500 mt-0.5">{agent.repoName || agent.name}{agent.machine ? ` (${agent.machine})` : ''}</p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl leading-none">&times;</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-4 md:px-6 md:py-5 space-y-4">
          {notes.length === 0 && !creating && (
            <p className="text-sm text-gray-600 italic text-center py-8">No notes yet</p>
          )}

          {notes.map((note) => (
            <div key={note.id} className="bg-white/[0.04] rounded-lg p-4 group">
              {editingId === note.id ? (
                <div className="space-y-3">
                  <textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    className="w-full glass-input text-gray-200 text-base rounded-md px-3 py-2.5 focus:outline-none resize-none"
                    rows={5}
                    autoFocus
                  />
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleUpdate(note.id)}
                      disabled={!editContent.trim()}
                      className="text-sm px-3 py-1.5 gl-gradient hover:opacity-90 text-white rounded-md disabled:opacity-30"
                    >
                      Save
                    </button>
                    {activeMemories.length > 0 && (
                      <button
                        onClick={() => setShowMemoryPicker(true)}
                        className="text-sm px-2.5 py-1.5 text-cyan-400 hover:text-cyan-300"
                      >
                        + Memory
                      </button>
                    )}
                    <button
                      onClick={() => { setEditingId(null); setEditContent(''); }}
                      className="text-sm px-2.5 py-1.5 text-gray-500 hover:text-gray-300"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="text-base text-gray-300 whitespace-pre-wrap break-words">{note.content}</p>
                  <div className="flex items-center justify-between mt-3">
                    <span className="text-xs text-gray-600">
                      {new Date(note.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                      {' '}
                      {new Date(note.updatedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <div className="flex items-center gap-3 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => handleCopy(note.content, note.id)}
                        className="text-xs text-gray-500 hover:text-gl-purple"
                      >
                        {copied === note.id ? 'Copied' : 'Copy'}
                      </button>
                      <button
                        onClick={() => startEdit(note)}
                        className="text-xs text-gray-500 hover:text-blue-400"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleDelete(note.id)}
                        className="text-xs text-gray-500 hover:text-red-400"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          ))}

          {/* New note form */}
          {creating && (
            <div className="bg-white/[0.04] rounded-lg p-4 space-y-3 border border-gl-purple/30">
              <textarea
                ref={textareaRef}
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
                placeholder="Write your note..."
                className="w-full glass-input text-gray-200 text-base rounded-md px-3 py-2.5 focus:outline-none resize-none placeholder-gray-600"
                rows={5}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleCreate();
                }}
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={handleCreate}
                  disabled={!newContent.trim()}
                  className="text-sm px-3 py-1.5 gl-gradient hover:opacity-90 text-white rounded-md disabled:opacity-30"
                >
                  Save
                </button>
                {activeMemories.length > 0 && (
                  <button
                    onClick={() => setShowMemoryPicker(true)}
                    className="text-sm px-2.5 py-1.5 text-cyan-400 hover:text-cyan-300"
                  >
                    + Memory
                  </button>
                )}
                <button
                  onClick={() => { setCreating(false); setNewContent(''); }}
                  className="text-sm px-2.5 py-1.5 text-gray-500 hover:text-gray-300"
                >
                  Cancel
                </button>
                <span className="text-xs text-gray-600 ml-auto">Cmd+Enter to save</span>
              </div>
            </div>
          )}

          {/* Memory picker dropdown */}
          {showMemoryPicker && (
            <div className="glass-light rounded-lg p-4 space-y-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs uppercase tracking-wider text-gray-500 font-semibold">
                  Insert memory
                </span>
                <button
                  onClick={() => setShowMemoryPicker(false)}
                  className="text-sm text-gray-500 hover:text-gray-300"
                >
                  &times;
                </button>
              </div>
              {activeMemories.length === 0 && (
                <p className="text-sm text-gray-600 italic">No active memories</p>
              )}
              {activeMemories.map((m) => (
                <button
                  key={m.id}
                  onClick={() => insertMemory(m)}
                  className="w-full text-left flex items-start gap-2 px-2.5 py-2 rounded hover:bg-gray-700/50 transition-colors"
                >
                  <span className="text-xs px-1.5 py-0.5 rounded bg-cyan-900/50 text-cyan-400 shrink-0 mt-0.5">
                    {m.category}
                  </span>
                  <span className="text-sm text-gray-400 break-words">{m.content}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        {!creating && editingId === null && (
          <div className="px-4 py-3 md:px-6 md:py-4 border-t border-white/[0.06]">
            <button
              onClick={() => setCreating(true)}
              className="text-sm px-4 py-2 gl-gradient hover:opacity-90 text-white rounded-md transition-colors"
            >
              + Add Note
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

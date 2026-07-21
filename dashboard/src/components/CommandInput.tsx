import { useState, useRef, useEffect, useCallback } from 'react';
import type { CommandAttachmentInput } from '../types';

const MAX_HISTORY = 50;
const MAX_ATTACHMENTS = 10;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

interface Props {
  onSend: (text: string, attachments?: CommandAttachmentInput[]) => void;
  placeholder?: string;
  agentId?: string;
  mode?: 'plan' | 'manual' | 'trust';
}

interface PendingAttachment {
  id: string;
  file: File;
  previewUrl?: string;
}

function loadHistory(agentId: string): string[] {
  try {
    const raw = localStorage.getItem(`neoncore:history:${agentId}`);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveHistory(agentId: string, history: string[]) {
  try {
    localStorage.setItem(`neoncore:history:${agentId}`, JSON.stringify(history.slice(0, MAX_HISTORY)));
  } catch {
    // localStorage full or unavailable
  }
}

export function CommandInput({ onSend, placeholder, agentId, mode }: Props) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [isEncoding, setIsEncoding] = useState(false);
  const [attachmentError, setAttachmentError] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef<PendingAttachment[]>([]);

  // History state
  const [history, setHistory] = useState<string[]>(() =>
    agentId ? loadHistory(agentId) : []
  );
  const [historyIndex, setHistoryIndex] = useState(-1);
  const savedCurrentRef = useRef('');

  // Reload history when agentId changes
  useEffect(() => {
    if (agentId) {
      setHistory(loadHistory(agentId));
      setHistoryIndex(-1);
      savedCurrentRef.current = '';
    }
  }, [agentId]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Auto-resize textarea to fit content
  const autoResize = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const maxHeight = 200; // ~10 lines
    el.style.height = Math.min(el.scrollHeight, maxHeight) + 'px';
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, []);

  useEffect(() => {
    autoResize();
  }, [text, autoResize]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => () => {
    attachmentsRef.current.forEach((attachment) => {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    });
  }, []);

  const addFiles = useCallback((files: FileList | File[]) => {
    const incoming = Array.from(files);
    if (incoming.length === 0) return;
    setAttachmentError('');
    setAttachments((prev) => {
      const next = [...prev];
      for (const file of incoming) {
        if (next.length >= MAX_ATTACHMENTS) {
          setAttachmentError(`Attach up to ${MAX_ATTACHMENTS} files.`);
          break;
        }
        const total = next.reduce((sum, item) => sum + item.file.size, 0) + file.size;
        if (total > MAX_TOTAL_BYTES) {
          setAttachmentError('Attachments must total 20 MB or less.');
          break;
        }
        next.push({
          id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2)}`,
          file,
          previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
        });
      }
      return next;
    });
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const removed = prev.find((attachment) => attachment.id === id);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((attachment) => attachment.id !== id);
    });
  }, []);

  const fileToPayload = (file: File): Promise<CommandAttachmentInput> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const value = String(reader.result || '');
        const comma = value.indexOf(',');
        resolve({
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          dataBase64: comma >= 0 ? value.slice(comma + 1) : value,
        });
      };
      reader.onerror = () => reject(reader.error || new Error(`Failed to read ${file.name}`));
      reader.readAsDataURL(file);
    });

  const clearAttachments = useCallback(() => {
    attachments.forEach((attachment) => {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    });
    setAttachments([]);
  }, [attachments]);

  const handleSubmit = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;
    setIsEncoding(true);
    setAttachmentError('');
    let payloads: CommandAttachmentInput[] = [];
    try {
      payloads = await Promise.all(attachments.map((attachment) => fileToPayload(attachment.file)));
    } catch (err) {
      setAttachmentError(err instanceof Error ? err.message : 'Could not read attachment.');
      setIsEncoding(false);
      return;
    }

    const outgoingText = trimmed || 'Please inspect the attached file(s).';
    onSend(outgoingText, payloads.length > 0 ? payloads : undefined);

    // Push to history
    if (agentId) {
      const newHistory = [outgoingText, ...history.filter((h) => h !== outgoingText)].slice(0, MAX_HISTORY);
      setHistory(newHistory);
      saveHistory(agentId, newHistory);
    }

    setText('');
    clearAttachments();
    setHistoryIndex(-1);
    savedCurrentRef.current = '';
    setIsEncoding(false);
  }, [text, attachments, onSend, agentId, history, clearAttachments]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
      return;
    }

    // Up arrow — navigate history backward
    if (e.key === 'ArrowUp' && history.length > 0) {
      const textarea = inputRef.current;
      // Only navigate if cursor is on the first line
      if (textarea) {
        const cursorPos = textarea.selectionStart;
        const textBeforeCursor = text.slice(0, cursorPos);
        if (textBeforeCursor.includes('\n')) return; // cursor not on first line
      }

      e.preventDefault();
      if (historyIndex < history.length - 1) {
        if (historyIndex === -1) {
          savedCurrentRef.current = text;
        }
        const newIndex = historyIndex + 1;
        setHistoryIndex(newIndex);
        setText(history[newIndex]);
      }
      return;
    }

    // Down arrow — navigate history forward
    if (e.key === 'ArrowDown' && historyIndex >= 0) {
      const textarea = inputRef.current;
      // Only navigate if cursor is on the last line
      if (textarea) {
        const cursorPos = textarea.selectionStart;
        const textAfterCursor = text.slice(cursorPos);
        if (textAfterCursor.includes('\n')) return; // cursor not on last line
      }

      e.preventDefault();
      const newIndex = historyIndex - 1;
      setHistoryIndex(newIndex);
      setText(newIndex === -1 ? savedCurrentRef.current : history[newIndex]);
      return;
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) addFiles(e.target.files);
          e.currentTarget.value = '';
        }}
      />
      <textarea
        ref={inputRef}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          // Reset history navigation when user types
          if (historyIndex >= 0) {
            setHistoryIndex(-1);
            savedCurrentRef.current = '';
          }
        }}
        onKeyDown={handleKeyDown}
        onPaste={(e) => {
          const files = e.clipboardData?.files;
          if (files && files.length > 0) {
            addFiles(files);
          }
        }}
        placeholder={placeholder || "Type an instruction for this agent..."}
        rows={1}
        className="w-full glass-input text-gray-200 text-base rounded-lg px-3 py-2.5 focus:outline-none resize-none placeholder-gray-600 overflow-hidden"
      />
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {attachments.map((attachment) => (
            <div
              key={attachment.id}
              className="flex items-center gap-2 rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 text-[13px] text-gray-300"
            >
              {attachment.previewUrl ? (
                <img src={attachment.previewUrl} alt="" className="h-7 w-7 rounded object-cover" />
              ) : (
                <span className="flex h-7 w-7 items-center justify-center rounded bg-white/[0.06] text-gray-500">#</span>
              )}
              <span className="max-w-[180px] truncate">{attachment.file.name}</span>
              <span className="text-gray-600">{Math.ceil(attachment.file.size / 1024)} KB</span>
              <button
                type="button"
                onClick={() => removeAttachment(attachment.id)}
                className="text-gray-500 hover:text-gray-200"
                title="Remove attachment"
              >
                x
              </button>
            </div>
          ))}
        </div>
      )}
      {attachmentError && <div className="text-[13px] text-red-400">{attachmentError}</div>}
      <div className="flex justify-between items-center">
        <span className="text-sm text-gray-600 flex items-center gap-2">
          {mode === 'plan' && <span className="text-indigo-400">Plan mode</span>}
          <span>Enter to send, Shift+Enter for newline, paste screenshots to attach</span>
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="text-sm px-3 py-1.5 text-gray-300 rounded-md border border-white/10 hover:bg-white/[0.04] transition-colors"
            title="Attach files"
          >
            Attach
          </button>
          <button
            onClick={handleSubmit}
            disabled={isEncoding || (!text.trim() && attachments.length === 0)}
            className={`text-sm px-3.5 py-1.5 text-white rounded-md disabled:opacity-30 disabled:cursor-not-allowed transition-colors ${
              mode === 'plan'
                ? 'bg-indigo-600 hover:bg-indigo-500'
                : 'gl-gradient hover:opacity-90'
            }`}
          >
            {isEncoding ? 'Preparing...' : mode === 'plan' ? 'Send (Plan)' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}

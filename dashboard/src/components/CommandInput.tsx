import { useState, useRef, useEffect, useCallback } from 'react';
import type { CommandAttachmentInput } from '../types';
import { AttachmentList, useAttachments } from './AttachmentPicker';
import { focusIfIdle } from '../lib/focus';

const MAX_HISTORY = 50;

interface Props {
  onSend: (text: string, attachments?: CommandAttachmentInput[]) => void;
  placeholder?: string;
  agentId?: string;
  mode?: 'plan' | 'manual' | 'trust';
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
  const [isEncoding, setIsEncoding] = useState(false);
  const {
    attachments,
    error: attachmentError,
    setError: setAttachmentError,
    addFiles,
    removeAttachment,
    clear: clearAttachments,
    encode: encodeAttachments,
  } = useAttachments();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  // Cards mount whenever an agent comes online or a cartridge is restored — never pull the
  // caret out of a field the user is already typing in.
  useEffect(() => {
    focusIfIdle(inputRef.current);
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

  const handleSubmit = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;
    setIsEncoding(true);
    setAttachmentError('');
    let payloads: CommandAttachmentInput[] = [];
    try {
      payloads = await encodeAttachments();
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
  }, [text, attachments, onSend, agentId, history, clearAttachments, encodeAttachments, setAttachmentError]);

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
    <div className="flex flex-col gap-1.5">
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
      {/* One field, Night Glass: the prompt, an attach icon and Send live on a single dark row. */}
      <div className="flex items-end gap-2 pl-3 pr-1.5 py-1.5 rounded-xl bg-[#050913]/90 border border-white/[0.14] focus-within:border-neon-500/70 focus-within:shadow-[0_0_0_2px_rgba(90,174,255,0.18)] transition-colors">
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
          className="flex-1 min-w-0 self-center bg-transparent border-0 text-gray-100 text-sm py-2 focus:outline-none resize-none placeholder-gray-500 overflow-hidden"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="shrink-0 w-9 h-9 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-100 hover:bg-white/[0.06] transition-colors"
          title="Attach files"
          aria-label="Attach"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M21 11l-9 9a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8" />
          </svg>
        </button>
        <button
          onClick={handleSubmit}
          disabled={isEncoding || (!text.trim() && attachments.length === 0)}
          className="btn-primary shrink-0 h-9 px-3.5 rounded-lg text-[13px] font-semibold disabled:opacity-40 disabled:shadow-none disabled:cursor-not-allowed transition-colors"
        >
          {isEncoding ? 'Preparing...' : mode === 'plan' ? 'Send (Plan)' : 'Send'}
        </button>
      </div>
      <AttachmentList attachments={attachments} onRemove={removeAttachment} />
      {attachmentError && <div className="text-[12px] text-red-400">{attachmentError}</div>}
      <span className="text-[12px] text-gray-500 flex items-center gap-2">
        {mode === 'plan' && <span className="text-neon-300 font-semibold">Plan mode</span>}
        <span>Enter to send · Shift+Enter newline · paste screenshots to attach</span>
      </span>
    </div>
  );
}

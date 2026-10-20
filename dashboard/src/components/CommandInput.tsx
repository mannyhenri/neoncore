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
      <AttachmentList attachments={attachments} onRemove={removeAttachment} />
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

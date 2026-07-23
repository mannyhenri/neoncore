import { useCallback, useEffect, useRef, useState } from 'react';
import type { CommandAttachmentInput } from '../types';

/**
 * Shared file-attachment UI + state for anything that dispatches a prompt: the cartridge
 * send box, a confer, a workflow run. All three post the same base64 payload, so they all
 * pull from here rather than each growing their own copy of the encode/limit/preview code.
 */

export const MAX_ATTACHMENTS = 10;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

export interface PendingAttachment {
  id: string;
  file: File;
  previewUrl?: string;
}

function fileToPayload(file: File): Promise<CommandAttachmentInput> {
  return new Promise((resolve, reject) => {
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
}

export function useAttachments() {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [error, setError] = useState('');
  const attachmentsRef = useRef<PendingAttachment[]>([]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  // Object URLs outlive React state unless we revoke them — do it on unmount too, or a
  // long-lived dashboard leaks a blob per screenshot pasted.
  useEffect(() => () => {
    attachmentsRef.current.forEach((a) => { if (a.previewUrl) URL.revokeObjectURL(a.previewUrl); });
  }, []);

  const addFiles = useCallback((files: FileList | File[]) => {
    const incoming = Array.from(files);
    if (incoming.length === 0) return;
    setError('');
    setAttachments((prev) => {
      const next = [...prev];
      for (const file of incoming) {
        if (next.length >= MAX_ATTACHMENTS) {
          setError(`Attach up to ${MAX_ATTACHMENTS} files.`);
          break;
        }
        const total = next.reduce((sum, item) => sum + item.file.size, 0) + file.size;
        if (total > MAX_TOTAL_BYTES) {
          setError('Attachments must total 20 MB or less.');
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
      const removed = prev.find((a) => a.id === id);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  const clear = useCallback(() => {
    setAttachments((prev) => {
      prev.forEach((a) => { if (a.previewUrl) URL.revokeObjectURL(a.previewUrl); });
      return [];
    });
    setError('');
  }, []);

  /** Base64-encode everything for the API. Throws with a message worth showing the user. */
  const encode = useCallback(
    (): Promise<CommandAttachmentInput[]> => Promise.all(attachments.map((a) => fileToPayload(a.file))),
    [attachments],
  );

  return { attachments, error, setError, addFiles, removeAttachment, clear, encode };
}

/** The chip list of staged files. Renders nothing when empty. */
export function AttachmentList({
  attachments,
  onRemove,
}: {
  attachments: PendingAttachment[];
  onRemove: (id: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
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
            onClick={() => onRemove(attachment.id)}
            className="text-gray-500 hover:text-gray-200"
            title="Remove attachment"
          >
            x
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Attach button + hidden file input + staged-file list + error line. Use this when the
 * surface has no existing toolbar to slot a button into (confer modal, workflow run modal);
 * CommandInput composes the pieces itself so the button can sit next to Send.
 */
export function AttachmentField({
  label = 'Attachments',
  hint = 'Optional — copied into the repo so the agents can open them.',
  attachments,
  error,
  onAddFiles,
  onRemove,
}: {
  label?: string;
  hint?: string;
  attachments: PendingAttachment[];
  error: string;
  onAddFiles: (files: FileList | File[]) => void;
  onRemove: (id: string) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="space-y-2">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) onAddFiles(e.target.files);
          e.currentTarget.value = '';
        }}
      />
      <div className="flex items-center justify-between">
        <span className="text-[13px] text-gray-500 uppercase tracking-wider">{label}</span>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="text-[12px] px-2.5 py-1 text-gray-300 rounded-md border border-white/10 hover:bg-white/[0.04] transition-colors"
        >
          Attach files
        </button>
      </div>
      <p className="text-[12px] text-gray-600">{hint}</p>
      <AttachmentList attachments={attachments} onRemove={onRemove} />
      {error && <div className="text-[13px] text-red-400">{error}</div>}
    </div>
  );
}

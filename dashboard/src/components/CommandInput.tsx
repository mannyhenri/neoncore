import { useState, useRef, useEffect } from 'react';

interface Props {
  onSend: (text: string) => void;
  placeholder?: string;
}

export function CommandInput({ onSend, placeholder }: Props) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText('');
  };

  return (
    <div className="flex flex-col gap-2">
      <textarea
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            handleSubmit();
          }
        }}
        placeholder={placeholder || "Type an instruction for this agent..."}
        rows={2}
        className="w-full bg-gray-800 text-gray-200 text-sm rounded-lg px-3 py-2 border border-gray-700 focus:border-neon-500 focus:outline-none resize-none placeholder-gray-600"
      />
      <div className="flex justify-between items-center">
        <span className="text-xs text-gray-600">Cmd+Enter to send</span>
        <button
          onClick={handleSubmit}
          disabled={!text.trim()}
          className="text-xs px-3 py-1 bg-neon-600 text-white rounded-md hover:bg-neon-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          Send
        </button>
      </div>
    </div>
  );
}

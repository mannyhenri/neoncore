import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import type { Session, ProjectKnowledge } from '../types';

interface Props {
  project: string;
  onClose: () => void;
}

const KNOWLEDGE_FILES = ['progress.md', 'decisions.md', 'gotchas.md'] as const;

export default function ProjectMemoryPanel({ project, onClose }: Props) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'sessions' | typeof KNOWLEDGE_FILES[number]>('sessions');
  const [fileContent, setFileContent] = useState('');
  const [fileDirty, setFileDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadSessions = useCallback(() => {
    api.getProjectSessions(project, 30).then(setSessions).catch(() => {});
  }, [project]);

  const loadFile = useCallback((filename: string) => {
    api.getKnowledgeFile(project, filename)
      .then((f) => { setFileContent(f.content); setFileDirty(false); })
      .catch(() => setFileContent(''));
  }, [project]);

  useEffect(() => {
    setLoading(true);
    loadSessions();
    setLoading(false);
  }, [loadSessions]);

  useEffect(() => {
    if (activeTab !== 'sessions') {
      loadFile(activeTab);
    }
  }, [activeTab, loadFile]);

  const handleSaveFile = async () => {
    if (activeTab === 'sessions') return;
    setSaving(true);
    try {
      await api.updateKnowledgeFile(project, activeTab, fileContent);
      setFileDirty(false);
    } catch { /* silent */ }
    setSaving(false);
  };

  const formatDuration = (start: string, end: string | null) => {
    if (!end) return 'active';
    const ms = new Date(end).getTime() - new Date(start).getTime();
    const min = Math.round(ms / 60000);
    if (min < 60) return `${min}m`;
    return `${Math.floor(min / 60)}h ${min % 60}m`;
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
      ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[#0d0f12] border border-white/[0.08] rounded-xl shadow-2xl w-[700px] max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
          <div>
            <h2 className="text-sm font-semibold text-white">Project Memory</h2>
            <p className="text-[10px] text-gray-500 mt-0.5">{project} &middot; {sessions.length} sessions</p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-lg">&times;</button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 px-4 pt-3 pb-2 border-b border-white/[0.06]">
          <TabButton active={activeTab === 'sessions'} onClick={() => setActiveTab('sessions')}>
            Sessions
          </TabButton>
          <TabButton active={activeTab === 'progress.md'} onClick={() => setActiveTab('progress.md')}>
            Progress
          </TabButton>
          <TabButton active={activeTab === 'decisions.md'} onClick={() => setActiveTab('decisions.md')}>
            Decisions
          </TabButton>
          <TabButton active={activeTab === 'gotchas.md'} onClick={() => setActiveTab('gotchas.md')}>
            Gotchas
          </TabButton>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {activeTab === 'sessions' ? (
            <SessionTimeline
              sessions={sessions}
              expandedSession={expandedSession}
              onToggle={(id) => setExpandedSession(expandedSession === id ? null : id)}
              formatDate={formatDate}
              formatDuration={formatDuration}
            />
          ) : (
            <KnowledgeEditor
              content={fileContent}
              onChange={(v) => { setFileContent(v); setFileDirty(true); }}
              dirty={fileDirty}
              saving={saving}
              onSave={handleSaveFile}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ──

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`text-xs px-3 py-1.5 rounded-md transition-colors ${
        active
          ? 'bg-white/[0.08] text-white font-medium'
          : 'text-gray-500 hover:text-gray-300 hover:bg-white/[0.04]'
      }`}
    >
      {children}
    </button>
  );
}

function SessionTimeline({
  sessions,
  expandedSession,
  onToggle,
  formatDate,
  formatDuration,
}: {
  sessions: Session[];
  expandedSession: string | null;
  onToggle: (id: string) => void;
  formatDate: (iso: string) => string;
  formatDuration: (start: string, end: string | null) => string;
}) {
  if (sessions.length === 0) {
    return <p className="text-xs text-gray-600 italic text-center py-8">No sessions recorded yet</p>;
  }

  return (
    <div className="space-y-2">
      {sessions.map((s) => {
        const isExpanded = expandedSession === s.id;
        // Extract first line of summary as title
        const firstLine = s.summary?.split('\n').find((l) => l.startsWith('### Task'));
        const taskLine = s.summary?.split('\n')[(s.summary?.split('\n').findIndex((l) => l.startsWith('### Task')) ?? -1) + 1] || '';

        return (
          <div
            key={s.id}
            className="border border-white/[0.06] rounded-lg overflow-hidden"
          >
            <button
              onClick={() => onToggle(s.id)}
              className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-white/[0.02] transition-colors"
            >
              <span className={`w-2 h-2 rounded-full shrink-0 ${
                s.status === 'active' ? 'bg-green-400 animate-pulse' :
                s.status === 'summarized' ? 'bg-cyan-400' : 'bg-gray-600'
              }`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-300 font-medium">{formatDate(s.startedAt)}</span>
                  <span className="text-[10px] text-gray-600">{formatDuration(s.startedAt, s.endedAt)}</span>
                  <span className="text-[10px] text-gray-600">{s.activityCount} actions</span>
                  {s.branch && (
                    <span className="text-[10px] text-purple-400/60 font-mono">{s.branch}</span>
                  )}
                </div>
                {taskLine && (
                  <p className="text-[11px] text-gray-500 truncate mt-0.5">{taskLine}</p>
                )}
              </div>
              <span className="text-gray-600 text-xs">{isExpanded ? '\u25B2' : '\u25BC'}</span>
            </button>

            {isExpanded && s.summary && (
              <div className="px-4 pb-3 pt-1 border-t border-white/[0.04]">
                <pre className="text-[11px] text-gray-400 whitespace-pre-wrap font-sans leading-relaxed">
                  {s.summary}
                </pre>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function KnowledgeEditor({
  content,
  onChange,
  dirty,
  saving,
  onSave,
}: {
  content: string;
  onChange: (v: string) => void;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
}) {
  return (
    <div className="flex flex-col h-full gap-2">
      <textarea
        value={content}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 min-h-[300px] w-full text-xs font-mono glass-input text-gray-300 rounded-lg px-4 py-3 placeholder-gray-600 focus:outline-none resize-none"
        placeholder="No content yet. Start typing..."
      />
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-gray-600">
          {dirty ? 'Unsaved changes' : 'Saved'}
        </span>
        <button
          onClick={onSave}
          disabled={!dirty || saving}
          className="text-xs px-4 py-1.5 rounded-md bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30 border border-cyan-500/20 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  );
}

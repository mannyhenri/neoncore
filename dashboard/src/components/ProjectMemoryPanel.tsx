import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import type { Agent, Session, WorkflowReport } from '../types';
import SendToCartridgeModal from './SendToCartridgeModal';

interface Props {
  project: string;
  agents?: Agent[];
  onClose: () => void;
}

// Three of the four files this used to list are retired — see server/src/lib/knowledge-files.ts.
// What replaced them is the Reports tab: the JSON each run's completion report produces.
const KNOWLEDGE_FILES = ['details.md'] as const;

type TabKey = 'sessions' | 'reports' | 'notes' | typeof KNOWLEDGE_FILES[number];

export default function ProjectMemoryPanel({ project, agents, onClose }: Props) {
  const [sendModal, setSendModal] = useState<{ text: string; label: string } | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('sessions');
  const [fileContent, setFileContent] = useState('');
  const [fileDirty, setFileDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<{
    sessions: { id: string; project: string; startedAt: string; summary: string }[];
    knowledge: { project: string; filename: string; snippet: string }[];
  } | null>(null);
  const [searching, setSearching] = useState(false);

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

  // Debounced search
  useEffect(() => {
    if (!searchQuery.trim() || searchQuery.trim().length < 2) {
      setSearchResults(null);
      return;
    }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const results = await api.searchJournal(searchQuery.trim(), project);
        setSearchResults(results);
      } catch {
        setSearchResults(null);
      }
      setSearching(false);
    }, 400);
    return () => clearTimeout(timer);
  }, [searchQuery, project]);

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
            <p className="text-[13px] text-gray-500 mt-0.5">{project} &middot; {sessions.length} sessions</p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-lg">&times;</button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 px-4 pt-3 pb-2 border-b border-white/[0.06]">
          <TabButton active={activeTab === 'sessions'} onClick={() => setActiveTab('sessions')}>
            Sessions
          </TabButton>
          <TabButton active={activeTab === 'reports'} onClick={() => setActiveTab('reports')}>
            Reports
          </TabButton>
          <TabButton active={activeTab === 'details.md'} onClick={() => setActiveTab('details.md')}>
            Project Details
          </TabButton>
          <TabButton active={activeTab === 'notes'} onClick={() => setActiveTab('notes')}>
            Notes
          </TabButton>
        </div>

        {/* Search bar */}
        <div className="px-4 py-2 border-b border-white/[0.04]">
          <div className="relative">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search sessions and knowledge…"
              className="w-full text-sm bg-white/[0.04] border border-white/[0.08] rounded-md px-3 py-1.5 pl-8 text-gray-300 placeholder-gray-600 focus:outline-none focus:border-purple-500/40"
            />
            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-600" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
            </svg>
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-600 hover:text-gray-400 text-sm"
              >
                ✕
              </button>
            )}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {/* Search results overlay */}
          {searchQuery.trim().length >= 2 && (
            <div className="mb-4">
              {searching ? (
                <p className="text-sm text-gray-500 text-center py-4">Searching…</p>
              ) : searchResults ? (
                <>
                  {searchResults.sessions.length === 0 && searchResults.knowledge.length === 0 ? (
                    <p className="text-sm text-gray-500 text-center py-4">No results for "{searchQuery}"</p>
                  ) : (
                    <div className="space-y-3">
                      {searchResults.sessions.length > 0 && (
                        <div>
                          <p className="text-[11px] text-gray-600 uppercase tracking-wider mb-2">Sessions ({searchResults.sessions.length})</p>
                          {searchResults.sessions.map((s) => (
                            <button
                              key={s.id}
                              onClick={() => { setSearchQuery(''); setActiveTab('sessions'); setExpandedSession(s.id); }}
                              className="w-full text-left p-2 rounded-md hover:bg-white/[0.04] transition-colors mb-1"
                            >
                              <div className="text-xs text-gray-500 mb-0.5">{new Date(s.startedAt).toLocaleDateString()}</div>
                              <div
                                className="text-[13px] text-gray-300 leading-snug"
                                dangerouslySetInnerHTML={{ __html: s.summary }}
                              />
                            </button>
                          ))}
                        </div>
                      )}
                      {searchResults.knowledge.length > 0 && (
                        <div>
                          <p className="text-[11px] text-gray-600 uppercase tracking-wider mb-2">Knowledge Files ({searchResults.knowledge.length})</p>
                          {searchResults.knowledge.map((k, i) => (
                            <button
                              key={i}
                              onClick={() => { setSearchQuery(''); setActiveTab(k.filename as TabKey); }}
                              className="w-full text-left p-2 rounded-md hover:bg-white/[0.04] transition-colors mb-1"
                            >
                              <div className="text-xs text-purple-400 mb-0.5">{k.filename}</div>
                              <div
                                className="text-[13px] text-gray-300 leading-snug"
                                dangerouslySetInnerHTML={{ __html: k.snippet }}
                              />
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </>
              ) : null}
            </div>
          )}

          {activeTab === 'sessions' ? (
            <SessionTimeline
              sessions={sessions}
              expandedSession={expandedSession}
              onToggle={(id) => setExpandedSession(expandedSession === id ? null : id)}
              formatDate={formatDate}
              formatDuration={formatDuration}
              onShare={agents?.length ? (text, label) => setSendModal({ text, label }) : undefined}
            />
          ) : activeTab === 'reports' ? (
            <ReportHistory
              project={project}
              formatDate={formatDate}
              onShare={agents?.length ? (text, label) => setSendModal({ text, label }) : undefined}
            />
          ) : activeTab === 'notes' ? (
            <NotesEditor
              project={project}
              onShare={agents?.length ? (text, label) => setSendModal({ text, label }) : undefined}
            />
          ) : (
            <KnowledgeEditor
              content={fileContent}
              onChange={(v) => { setFileContent(v); setFileDirty(true); }}
              dirty={fileDirty}
              saving={saving}
              onSave={handleSaveFile}
              onShare={agents?.length ? () => setSendModal({ text: fileContent, label: `${activeTab} — ${project}` }) : undefined}
            />
          )}
        </div>
      </div>

      {sendModal && agents && (
        <SendToCartridgeModal
          initialText={sendModal.text}
          sourceLabel={sendModal.label}
          agents={agents}
          onClose={() => setSendModal(null)}
        />
      )}
    </div>
  );
}

// ── Sub-components ──

/**
 * The completion reports this project's runs produced — what replaced Progress / Decisions /
 * Gotchas.
 *
 * Those three were appended to on every session hook and read by nobody. This is written once
 * per run, by the agent that did the work, and it is the same JSON the run's HTML report was
 * rendered from — so the summary here and the document cannot disagree.
 *
 * The executive summary is shown open because it is the part written to be read on its own; the
 * rest of the JSON is one click away rather than on the page, since a run's full report is
 * several screens of it.
 */
function ReportHistory({ project, formatDate, onShare }: {
  project: string;
  formatDate: (iso: string) => string;
  onShare?: (text: string, label: string) => void;
}) {
  const [reports, setReports] = useState<WorkflowReport[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api.getProjectReports(project).then(setReports).catch(() => {}).finally(() => setLoaded(true));
  }, [project]);

  if (loaded && reports.length === 0) {
    return (
      <div className="px-4 py-8 text-center">
        <p className="text-sm text-gray-500">No completion reports yet.</p>
        <p className="text-[11px] text-gray-600 mt-2 max-w-md mx-auto">
          Every workflow ends by writing one. It appears here once a run on this repo finishes
          its final step.
        </p>
      </div>
    );
  }

  const TONE: Record<string, string> = {
    SUCCESS: 'text-emerald-400 border-emerald-400/30 bg-emerald-500/10',
    PARTIAL: 'text-amber-400 border-amber-400/30 bg-amber-500/10',
    FAILED: 'text-red-400 border-red-400/30 bg-red-500/10',
    BLOCKED: 'text-red-400 border-red-400/30 bg-red-500/10',
  };

  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      {reports.map((r) => {
        const rep = r.report as Record<string, unknown>;
        const summary = typeof rep.executiveSummary === 'string' ? rep.executiveSummary : '';
        const outcome = rep.outcome as Record<string, unknown> | undefined;
        const open = expanded === r.id;
        return (
          <div key={r.id} className="border border-white/[0.06] rounded-md bg-white/[0.02]">
            <div className="flex items-start gap-3 px-3 py-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm text-gray-200">{r.workflowName}</span>
                  {r.runNumber > 0 && <span className="text-[11px] text-gray-600">#{r.runNumber}</span>}
                  {r.status && (
                    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${TONE[r.status] || 'text-gray-400 border-white/10'}`}>
                      {r.status}
                    </span>
                  )}
                  <span className="text-[11px] text-gray-600">{formatDate(r.createdAt)}</span>
                </div>
                {summary && <p className="text-[13px] text-gray-400 mt-1.5 leading-relaxed">{summary}</p>}
                {outcome && (
                  <p className="text-[11px] text-gray-600 mt-1.5 font-mono">
                    tasks {String(outcome.tasksCompleted ?? '?')}/{String(outcome.tasksTotal ?? '?')}
                    {' · '}tests {String(outcome.testsPassed ?? '?')}/{String(outcome.testsTotal ?? '?')}
                    {Number(outcome.issues) > 0 && ` · ${outcome.issues} issue(s)`}
                    {Number(outcome.humanActionsRequired) > 0 && ` · ${outcome.humanActionsRequired} awaiting you`}
                  </p>
                )}
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0">
                {r.htmlUrl && (
                  // The readable half. A server URL, so it actually opens — a file:// link
                  // from this page would be silently refused by the browser.
                  <a
                    href={r.htmlUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[11px] text-emerald-400 hover:text-emerald-300"
                  >
                    Open report ↗
                  </a>
                )}
                <button
                  onClick={() => setExpanded(open ? null : r.id)}
                  className="text-[11px] text-gray-500 hover:text-gray-300"
                >
                  {open ? 'Hide JSON' : 'JSON'}
                </button>
                {onShare && (
                  <button
                    onClick={() => onShare(JSON.stringify(r.report, null, 2), `${r.workflowName} report — ${project}`)}
                    className="text-[11px] text-gray-500 hover:text-gray-300"
                  >
                    Send
                  </button>
                )}
              </div>
            </div>
            {open && (
              <pre className="text-[11px] font-mono text-gray-400 px-3 pb-3 overflow-x-auto whitespace-pre-wrap border-t border-white/[0.04] pt-2">
                {JSON.stringify(r.report, null, 2)}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}


function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`text-sm px-3 py-1.5 rounded-md transition-colors ${
        active
          ? 'bg-white/[0.08] text-white font-medium'
          : 'text-gray-500 hover:text-gray-300 hover:bg-white/[0.04]'
      }`}
    >
      {children}
    </button>
  );
}

function ShareButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className="text-[13px] text-emerald-500 hover:text-emerald-400 opacity-0 group-hover:opacity-100 transition-all flex items-center gap-1"
      title="Send to another cartridge"
    >
      <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
      </svg>
      Share
    </button>
  );
}

function SessionTimeline({
  sessions,
  expandedSession,
  onToggle,
  formatDate,
  formatDuration,
  onShare,
}: {
  sessions: Session[];
  expandedSession: string | null;
  onToggle: (id: string) => void;
  formatDate: (iso: string) => string;
  formatDuration: (start: string, end: string | null) => string;
  onShare?: (text: string, label: string) => void;
}) {
  if (sessions.length === 0) {
    return <p className="text-sm text-gray-600 italic text-center py-8">No sessions recorded yet</p>;
  }

  return (
    <div className="space-y-2">
      {sessions.map((s) => {
        const isExpanded = expandedSession === s.id;
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
                  <span className="text-sm text-gray-300 font-medium">{formatDate(s.startedAt)}</span>
                  <span className="text-[13px] text-gray-600">{formatDuration(s.startedAt, s.endedAt)}</span>
                  <span className="text-[13px] text-gray-600">{s.activityCount} actions</span>
                  {s.branch && (
                    <span className="text-[13px] text-purple-400/60 font-mono">{s.branch}</span>
                  )}
                </div>
                {taskLine && (
                  <p className="text-[13px] text-gray-500 truncate mt-0.5">{taskLine}</p>
                )}
              </div>
              <span className="text-gray-600 text-sm">{isExpanded ? '\u25B2' : '\u25BC'}</span>
            </button>

            {isExpanded && s.summary && (
              <div className="px-4 pb-3 pt-1 border-t border-white/[0.04] group">
                <pre className="text-[13px] text-gray-400 whitespace-pre-wrap font-sans leading-relaxed">
                  {s.summary}
                </pre>
                {onShare && (
                  <div className="mt-2 flex justify-end">
                    <ShareButton onClick={() => onShare(s.summary, `Session ${formatDate(s.startedAt)}`)} />
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function NotesEditor({ project, onShare }: { project: string; onShare?: (text: string, label: string) => void }) {
  const [notes, setNotes] = useState<{ id: string; content: string; createdAt: string; updatedAt: string }[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [newContent, setNewContent] = useState('');

  const load = useCallback(() => {
    api.getProjectNotes(project).then(setNotes).catch(() => {});
  }, [project]);

  useEffect(load, [load]);

  const handleCreate = async () => {
    if (!newContent.trim()) return;
    await api.createProjectNote(project, newContent.trim());
    setNewContent('');
    load();
  };

  const handleUpdate = async (id: string) => {
    if (!editContent.trim()) return;
    await api.updateProjectNote(project, id, editContent.trim());
    setEditingId(null);
    load();
  };

  const handleDelete = async (id: string) => {
    await api.deleteProjectNote(project, id);
    if (editingId === id) setEditingId(null);
    load();
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
      ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  };

  return (
    <div className="space-y-3">
      {/* New note input */}
      <div className="flex gap-2">
        <textarea
          value={newContent}
          onChange={(e) => setNewContent(e.target.value)}
          placeholder="Add a note..."
          rows={4}
          className="flex-1 text-base font-mono glass-input text-gray-300 rounded-lg px-3 py-2.5 placeholder-gray-600 focus:outline-none resize-y min-h-[80px]"
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleCreate(); }}
        />
        <button
          onClick={handleCreate}
          disabled={!newContent.trim()}
          className="text-sm px-3 py-1.5 rounded-md bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30 border border-cyan-500/20 transition-colors disabled:opacity-30 self-end"
        >
          Add
        </button>
      </div>

      {notes.length === 0 && (
        <p className="text-sm text-gray-600 italic text-center py-4">No notes yet</p>
      )}

      {notes.map((note) => (
        <div key={note.id} className="border border-white/[0.06] rounded-lg p-3 group">
          {editingId === note.id ? (
            <div className="space-y-2">
              <textarea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                rows={5}
                className="w-full text-base font-mono glass-input text-gray-300 rounded-lg px-3 py-2.5 focus:outline-none resize-y min-h-[100px]"
              />
              <div className="flex gap-2">
                <button onClick={() => handleUpdate(note.id)} className="text-[13px] px-2 py-1 bg-cyan-500/20 text-cyan-400 rounded hover:bg-cyan-500/30">Save</button>
                <button onClick={() => setEditingId(null)} className="text-[13px] px-2 py-1 text-gray-500 hover:text-white">Cancel</button>
              </div>
            </div>
          ) : (
            <>
              <pre className="text-base text-gray-300 whitespace-pre-wrap font-sans leading-relaxed">{note.content}</pre>
              <div className="flex items-center justify-between mt-2">
                <span className="text-sm text-gray-600">{formatDate(note.updatedAt)}</span>
                <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  {onShare && (
                    <ShareButton onClick={() => onShare(note.content, `Note — ${formatDate(note.updatedAt)}`)} />
                  )}
                  <button
                    onClick={() => { setEditingId(note.id); setEditContent(note.content); }}
                    className="text-[13px] text-gray-500 hover:text-white"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDelete(note.id)}
                    className="text-[13px] text-gray-500 hover:text-red-400"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function KnowledgeEditor({
  content,
  onChange,
  dirty,
  saving,
  onSave,
  onShare,
}: {
  content: string;
  onChange: (v: string) => void;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onShare?: () => void;
}) {
  return (
    <div className="flex flex-col h-full gap-2">
      <textarea
        value={content}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 min-h-[300px] w-full text-sm font-mono glass-input text-gray-300 rounded-lg px-4 py-3 placeholder-gray-600 focus:outline-none resize-none"
        placeholder="No content yet. Start typing..."
      />
      <div className="flex items-center justify-between">
        <span className="text-[13px] text-gray-600">
          {dirty ? 'Unsaved changes' : 'Saved'}
        </span>
        <div className="flex items-center gap-2">
          {onShare && content.trim() && (
            <button
              onClick={onShare}
              className="text-sm px-3 py-1.5 rounded-md text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/20 transition-colors flex items-center gap-1.5"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
              </svg>
              Share
            </button>
          )}
          <button
            onClick={onSave}
            disabled={!dirty || saving}
            className="text-sm px-4 py-1.5 rounded-md bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30 border border-cyan-500/20 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

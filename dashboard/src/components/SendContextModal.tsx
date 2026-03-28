import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api';

interface ContextSession {
  id: string;
  startedAt: string;
  summary: string;
  branch: string;
}

interface Props {
  agentId: string;
  project: string;
  onClose: () => void;
}

export default function SendContextModal({ agentId, project, onClose }: Props) {
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [sessions, setSessions] = useState<ContextSession[]>([]);
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set());
  const [includeProgress, setIncludeProgress] = useState(false);
  const [includeGotchas, setIncludeGotchas] = useState(false);
  const [includeDecisions, setIncludeDecisions] = useState(false);
  const [includeDetails, setIncludeDetails] = useState(false);
  const [hasProgress, setHasProgress] = useState(false);
  const [hasGotchas, setHasGotchas] = useState(false);
  const [hasDecisions, setHasDecisions] = useState(false);
  const [hasDetails, setHasDetails] = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.getContextOptions(agentId)
      .then((opts) => {
        setSessions(opts.sessions);
        setHasProgress(opts.hasProgress);
        setHasGotchas(opts.hasGotchas);
        setHasDecisions(opts.hasDecisions);
        setHasDetails(opts.hasDetails);
        // Pre-select knowledge files that have content
        if (opts.hasProgress) setIncludeProgress(true);
        if (opts.hasGotchas) setIncludeGotchas(true);
        if (opts.hasDetails) setIncludeDetails(true);
        // Pre-select first 2 sessions
        const preselect = new Set(opts.sessions.slice(0, 2).map((s) => s.id));
        setSelectedSessions(preselect);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [agentId]);

  const toggleSession = (id: string) => {
    setSelectedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllSessions = () => {
    setSelectedSessions(new Set(sessions.map((s) => s.id)));
  };

  const selectNoneSessions = () => {
    setSelectedSessions(new Set());
  };

  const hasAnythingSelected = selectedSessions.size > 0 || includeProgress || includeGotchas || includeDecisions || includeDetails;

  const handleSend = async () => {
    if (!hasAnythingSelected) return;
    setSending(true);
    try {
      await api.sendContext(agentId, {
        sessionIds: [...selectedSessions],
        includeProgress,
        includeGotchas,
        includeDecisions,
        includeDetails,
      });
      onClose();
    } catch {
      setSending(false);
    }
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
      ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  };

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === backdropRef.current) onClose(); }}
    >
      <div className="bg-[#0d0f12] border border-white/[0.08] rounded-xl shadow-2xl w-[500px] max-h-[70vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
          <div>
            <h2 className="text-sm font-semibold text-white">Send Context</h2>
            <p className="text-[10px] text-gray-500 mt-0.5">{project}</p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-lg">&times;</button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {loading ? (
            <div className="text-xs text-gray-500 text-center py-8">Loading...</div>
          ) : (
            <>
              {/* Knowledge Files */}
              <div className="space-y-2">
                <span className="text-[10px] text-gray-500 uppercase tracking-wider">Knowledge Files</span>
                <label className={`flex items-center gap-2 text-xs ${hasProgress ? 'text-gray-300' : 'text-gray-600'}`}>
                  <input type="checkbox" checked={includeProgress} onChange={() => setIncludeProgress(!includeProgress)} disabled={!hasProgress}
                    className="rounded border-white/20 bg-white/5 text-gl-purple focus:ring-gl-purple/50" />
                  Progress
                </label>
                <label className={`flex items-center gap-2 text-xs ${hasGotchas ? 'text-gray-300' : 'text-gray-600'}`}>
                  <input type="checkbox" checked={includeGotchas} onChange={() => setIncludeGotchas(!includeGotchas)} disabled={!hasGotchas}
                    className="rounded border-white/20 bg-white/5 text-gl-purple focus:ring-gl-purple/50" />
                  Gotchas
                </label>
                <label className={`flex items-center gap-2 text-xs ${hasDecisions ? 'text-gray-300' : 'text-gray-600'}`}>
                  <input type="checkbox" checked={includeDecisions} onChange={() => setIncludeDecisions(!includeDecisions)} disabled={!hasDecisions}
                    className="rounded border-white/20 bg-white/5 text-gl-purple focus:ring-gl-purple/50" />
                  Decisions
                </label>
                <label className={`flex items-center gap-2 text-xs ${hasDetails ? 'text-gray-300' : 'text-gray-600'}`}>
                  <input type="checkbox" checked={includeDetails} onChange={() => setIncludeDetails(!includeDetails)} disabled={!hasDetails}
                    className="rounded border-white/20 bg-white/5 text-gl-purple focus:ring-gl-purple/50" />
                  Project Details
                </label>
              </div>

              {/* Sessions */}
              {sessions.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-gray-500 uppercase tracking-wider">Sessions</span>
                    <div className="flex gap-2">
                      <button onClick={selectAllSessions} className="text-[10px] text-gray-500 hover:text-white">All</button>
                      <button onClick={selectNoneSessions} className="text-[10px] text-gray-500 hover:text-white">None</button>
                    </div>
                  </div>
                  <div className="space-y-1 max-h-[200px] overflow-y-auto">
                    {sessions.map((s) => (
                      <label key={s.id} className="flex items-start gap-2 text-xs text-gray-300 p-1.5 rounded hover:bg-white/5 cursor-pointer">
                        <input type="checkbox" checked={selectedSessions.has(s.id)} onChange={() => toggleSession(s.id)}
                          className="mt-0.5 rounded border-white/20 bg-white/5 text-gl-purple focus:ring-gl-purple/50" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-gray-400">{formatDate(s.startedAt)}</span>
                            {s.branch && <span className="text-[10px] text-purple-400/60">{s.branch}</span>}
                          </div>
                          <p className="text-[11px] text-gray-500 truncate mt-0.5">{s.summary}</p>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {sessions.length === 0 && !hasProgress && !hasGotchas && !hasDecisions && !hasDetails && (
                <div className="text-xs text-gray-500 text-center py-8">No context available for this project yet.</div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-white/[0.06] flex items-center gap-3">
          <button
            onClick={handleSend}
            disabled={sending || !hasAnythingSelected}
            className="text-sm px-4 py-2 gl-gradient hover:opacity-90 text-white rounded-md disabled:opacity-30 transition-colors"
          >
            {sending ? 'Sending...' : 'Send Context'}
          </button>
          <button onClick={onClose} className="text-sm px-3 py-2 text-gray-500 hover:text-white transition-colors">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

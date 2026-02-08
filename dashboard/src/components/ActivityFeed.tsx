import { useState } from 'react';
import Markdown from 'react-markdown';
import type { Activity, Agent } from '../types';

interface Props {
  activities: Activity[];
  agents: Agent[];
}

const TOOL_COLORS: Record<string, string> = {
  Bash: 'text-orange-400',
  Edit: 'text-blue-400',
  Write: 'text-blue-300',
  Read: 'text-gray-400',
  Glob: 'text-purple-400',
  Grep: 'text-purple-300',
  WebFetch: 'text-cyan-400',
  WebSearch: 'text-cyan-300',
  Task: 'text-yellow-400',
  TodoWrite: 'text-pink-400',
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function summarizeToolInput(toolName: string, toolInput: string): string {
  try {
    const input = JSON.parse(toolInput);
    switch (toolName) {
      case 'Bash':
        return input.command?.slice(0, 80) || '';
      case 'Edit':
      case 'Write':
      case 'Read':
        return input.file_path?.split('/').pop() || '';
      case 'Glob':
        return input.pattern || '';
      case 'Grep':
        return input.pattern || '';
      case 'WebFetch':
      case 'WebSearch':
        return input.url || input.query || '';
      case 'Task':
        return input.description || '';
      case 'TodoWrite': {
        const todos = input.todos || [];
        const done = todos.filter((t: { status: string }) => t.status === 'completed').length;
        const active = todos.find((t: { status: string }) => t.status === 'in_progress');
        if (active) return `[${done}/${todos.length}] ${active.activeForm || active.content}`;
        return `[${done}/${todos.length}] tasks`;
      }
      default:
        return '';
    }
  } catch {
    return '';
  }
}

function plainTextPreview(text: string): string {
  // Strip markdown formatting for single-line preview
  return text
    .replace(/#{1,6}\s/g, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function ToolActivity({ activity, agentName }: { activity: Activity; agentName: string }) {
  const toolColor = TOOL_COLORS[activity.toolName] || 'text-gray-400';
  const summary = summarizeToolInput(activity.toolName, activity.toolInput);

  return (
    <div className="px-4 py-2 hover:bg-gray-800/50 transition-colors">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-gray-600 font-mono w-16 shrink-0">
          {formatTime(activity.timestamp)}
        </span>
        <span className="text-neon-400 font-mono truncate w-24 shrink-0">
          {agentName}
        </span>
        <span className={`font-mono font-medium shrink-0 ${toolColor}`}>
          {activity.toolName}
        </span>
        {summary && (
          <span className="text-gray-500 truncate font-mono">
            {summary}
          </span>
        )}
      </div>
    </div>
  );
}

function MessageActivity({ activity, agentName }: { activity: Activity; agentName: string }) {
  const [expanded, setExpanded] = useState(false);
  const message = activity.toolInput;
  const preview = plainTextPreview(message);
  const isLong = message.length > 150 || message.includes('\n');

  return (
    <div className="hover:bg-gray-800/50 transition-colors">
      {/* Single-line collapsed row */}
      <div
        className={`px-4 py-2 flex items-center gap-2 text-xs ${isLong ? 'cursor-pointer' : ''}`}
        onClick={() => isLong && setExpanded(!expanded)}
      >
        <span className="text-gray-600 font-mono w-16 shrink-0">
          {formatTime(activity.timestamp)}
        </span>
        <span className="text-neon-400 font-mono truncate w-24 shrink-0">
          {agentName}
        </span>
        <span className="text-indigo-400 font-medium shrink-0">
          Claude
        </span>
        <span className="text-gray-400 truncate min-w-0 flex-1">
          {preview}
        </span>
        {isLong && (
          <button
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
            className="text-gray-500 hover:text-gray-300 transition-colors shrink-0 p-1"
          >
            <svg
              className={`w-4 h-4 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>
        )}
      </div>

      {/* Expanded markdown content */}
      {expanded && (
        <div className="px-4 pb-3 ml-[4.5rem]">
          <div className="prose prose-invert prose-sm max-w-none
            prose-p:my-1 prose-p:text-gray-300 prose-p:leading-relaxed
            prose-headings:text-gray-200 prose-headings:mt-2 prose-headings:mb-1
            prose-code:text-neon-300 prose-code:bg-gray-800 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-xs
            prose-pre:bg-gray-800 prose-pre:border prose-pre:border-gray-700 prose-pre:rounded-lg prose-pre:text-xs
            prose-li:text-gray-300 prose-li:my-0.5
            prose-strong:text-gray-200
            prose-a:text-neon-400"
          >
            <Markdown>{message}</Markdown>
          </div>
        </div>
      )}
    </div>
  );
}

function UserCommandActivity({ activity, agentName }: { activity: Activity; agentName: string }) {
  return (
    <div className="px-4 py-2 hover:bg-gray-800/50 transition-colors">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-gray-600 font-mono w-16 shrink-0">
          {formatTime(activity.timestamp)}
        </span>
        <span className="text-neon-400 font-mono truncate w-24 shrink-0">
          {agentName}
        </span>
        <span className="text-emerald-400 font-medium shrink-0">
          You
        </span>
        <span className="text-gray-400 truncate min-w-0 flex-1">
          {activity.toolInput}
        </span>
      </div>
    </div>
  );
}

export function ActivityFeed({ activities, agents }: Props) {
  const [filterAgentId, setFilterAgentId] = useState<string>('all');

  const filtered = filterAgentId === 'all'
    ? activities
    : activities.filter((a) => a.agentId === filterAgentId);

  // Only show agents that have activity
  const activeAgentIds = new Set(activities.map((a) => a.agentId));
  const filterableAgents = agents.filter((a) => activeAgentIds.has(a.id));

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
        <h2 className="text-gray-300 font-semibold text-sm uppercase tracking-wide">
          Activity Feed
        </h2>
        {filterableAgents.length > 1 && (
          <select
            value={filterAgentId}
            onChange={(e) => setFilterAgentId(e.target.value)}
            className="text-xs bg-gray-800 text-gray-300 border border-gray-700 rounded-md px-2 py-1 focus:outline-none focus:border-neon-500"
          >
            <option value="all">All agents</option>
            {filterableAgents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.repoName || agent.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="max-h-[32rem] overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="px-4 py-8 text-center text-gray-600 text-sm">
            {filterAgentId === 'all'
              ? 'No activity yet. Connect an agent to see tool usage here.'
              : 'No activity for this agent.'}
          </div>
        ) : (
          <div className="divide-y divide-gray-800/50">
            {filtered.map((activity) => {
              const agent = agents.find((a) => a.id === activity.agentId);
              const agentName = agent?.repoName || 'Unknown';

              if (activity.eventType === 'assistant_message') {
                return <MessageActivity key={activity.id} activity={activity} agentName={agentName} />;
              }

              if (activity.eventType === 'user_command' || activity.eventType === 'user_prompt') {
                return <UserCommandActivity key={activity.id} activity={activity} agentName={agentName} />;
              }

              return <ToolActivity key={activity.id} activity={activity} agentName={agentName} />;
            })}
          </div>
        )}
      </div>
    </div>
  );
}

import { useState, useCallback, useEffect, useMemo } from 'react';
import type { Agent, AgentMode, Activity, PermissionRequest, StuckAlert } from '../types';
import { AgentModeSelector } from './AgentModeSelector';
import { CommandInput } from './CommandInput';
import { GitPanel } from './GitPanel';
import ProjectMemoryPanel from './ProjectMemoryPanel';
import SendContextModal from './SendContextModal';
import { api } from '../lib/api';

// ---------------------------------------------------------------------------
// 8-bit pixel art sprites (hand-crafted Atari/NES-style game characters)
// ---------------------------------------------------------------------------

// Each sprite is an array of row strings. '#' = filled pixel, '.' = empty.
// All sprites are 11 wide × 8 tall for consistent sizing.
const SPRITES: string[][] = [
  [ // Space Invader (crab)
    '..#.....#..',
    '...#...#...',
    '..#######..',
    '.##.###.##.',
    '###########',
    '#.#######.#',
    '#.#.....#.#',
    '...##.##...',
  ],
  [ // Space Invader (squid)
    '.....#.....',
    '....###....',
    '...#####...',
    '..##.#.##..',
    '..#######..',
    '....#.#....',
    '...#...#...',
    '..#.....#..',
  ],
  [ // Ghost (Pac-Man)
    '...#####...',
    '..#######..',
    '.##.##.##..',
    '.#########.',
    '.#########.',
    '.#########.',
    '.#########.',
    '.#.##.##.#.',
  ],
  [ // Pac-Man
    '...####....',
    '..######...',
    '.########..',
    '.######....',
    '.####......',
    '.######....',
    '..######...',
    '...####....',
  ],
  [ // Rocket ship
    '.....#.....',
    '....###....',
    '....###....',
    '...#####...',
    '...#####...',
    '..##.#.##..',
    '.##.###.##.',
    '.#...#...#.',
  ],
  [ // Robot
    '..#######..',
    '..#.#.#.#..',
    '..#######..',
    '...#####...',
    '.#########.',
    '...#####...',
    '..##...##..',
    '..##...##..',
  ],
  [ // Heart
    '..##...##..',
    '.####.####.',
    '.#########.',
    '.#########.',
    '..#######..',
    '...#####...',
    '....###....',
    '.....#.....',
  ],
  [ // Skull
    '..#######..',
    '.#########.',
    '.##.###.##.',
    '.#########.',
    '.#########.',
    '...#.#.#...',
    '..#######..',
    '..#.#.#.#..',
  ],
  [ // Crown
    '.#...#...#.',
    '.##.###.##.',
    '.#########.',
    '.#########.',
    '.#########.',
    '.#########.',
    '..#######..',
    '...........',
  ],
  [ // Mushroom (Mario-style)
    '...#####...',
    '..##.#.##..',
    '.###.#.###.',
    '.##.###.##.',
    '.#########.',
    '...#####...',
    '...#####...',
    '...#####...',
  ],
  [ // Alien face
    '..#.....#..',
    '.#.#####.#.',
    '.#.##.##.#.',
    '.#.#####.#.',
    '.#########.',
    '..#.###.#..',
    '..#.....#..',
    '...#####...',
  ],
  [ // Shield / badge
    '.#########.',
    '###########',
    '###.###.###',
    '###########',
    '.#########.',
    '..#######..',
    '...#####...',
    '....###....',
  ],
  [ // Sword
    '.....#.....',
    '.....#.....',
    '.....#.....',
    '.....#.....',
    '....###....',
    '.....#.....',
    '...#####...',
    '....###....',
  ],
  [ // Tank
    '....##.....',
    '..########.',
    '.##########',
    '.#..#..#..#',
    '.##########',
    '.#.######.#',
    '..########.',
    '...........',
  ],
  [ // Star / power-up
    '.....#.....',
    '....###....',
    '.#########.',
    '..#######..',
    '...#####...',
    '..##...##..',
    '.##.....##.',
    '.#.......#.',
  ],
  [ // Castle turret
    '.#.###.#...',
    '.#.###.#...',
    '.#########.',
    '..#######..',
    '..#.#.#.#..',
    '..#######..',
    '..#######..',
    '..#######..',
  ],
  [ // Lightning bolt
    '...####....',
    '..####.....',
    '.####......',
    '..########.',
    '......####.',
    '.....####..',
    '....####...',
    '...........',
  ],
  [ // Diamond / gem
    '.....#.....',
    '....###....',
    '...#####...',
    '..#######..',
    '..#######..',
    '...#####...',
    '....###....',
    '.....#.....',
  ],
  [ // Dragon / monster
    '.##.....##.',
    '.###...###.',
    '..#######..',
    '.#.##.##.#.',
    '.#########.',
    '..#.....#..',
    '.##.###.##.',
    '.#.......#.',
  ],
  [ // Spaceship (wide)
    '.....#.....',
    '...#####...',
    '..#######..',
    '.####.####.',
    '###########',
    '#.###.###.#',
    '..#.....#..',
    '...........',
  ],
  [ // Tree
    '.....#.....',
    '....###....',
    '...#####...',
    '..#######..',
    '.#########.',
    '...#####...',
    '....###....',
    '....###....',
  ],
  [ // Potion / flask
    '...#####...',
    '....###....',
    '....###....',
    '...#####...',
    '..#######..',
    '..##.####..',
    '..#######..',
    '...#####...',
  ],
  [ // Key
    '..####.....',
    '..#..#.....',
    '..####.....',
    '....#......',
    '....####...',
    '....#......',
    '....###....',
    '...........',
  ],
  [ // Music note
    '......####.',
    '......#..#.',
    '......#..#.',
    '......#..#.',
    '..##..#....',
    '.####.#....',
    '.####.####.',
    '..##..####.',
  ],
];

// Color palettes — each sprite gets a primary + accent color
const SPRITE_COLORS = [
  ['#e74c3c', '#ff6b6b'],  // red
  ['#e67e22', '#ffa04c'],  // orange
  ['#f1c40f', '#ffe066'],  // yellow
  ['#2ecc71', '#6ff5a5'],  // green
  ['#1abc9c', '#55efc4'],  // teal
  ['#3498db', '#74b9ff'],  // blue
  ['#9b59b6', '#c39bd3'],  // purple
  ['#e84393', '#fd79a8'],  // pink
  ['#00cec9', '#55f5f0'],  // cyan
  ['#6c5ce7', '#a29bfe'],  // indigo
  ['#fdcb6e', '#ffeaa7'],  // gold
  ['#00b894', '#55efc4'],  // mint
];

function hashStr(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** Render a sprite grid to an SVG data URL. */
function spriteToSvg(sprite: string[], primary: string, accent: string): string {
  const W = sprite[0].length;
  const H = sprite.length;
  const rects: string[] = [];

  for (let y = 0; y < H; y++) {
    const row = sprite[y];
    for (let x = 0; x < W; x++) {
      if (row[x] === '#') {
        const color = ((x + y) % 3 === 0) ? accent : primary;
        rects.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="${color}"/>`);
      }
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges">${rects.join('')}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Generate a second animation frame by shifting the bottom rows. */
function generateFrame2(sprite: string[]): string[] {
  const f2 = [...sprite];
  // Shift bottom 3 rows right by 1 pixel (circular) to simulate movement
  for (let i = Math.max(0, f2.length - 3); i < f2.length; i++) {
    const row = f2[i];
    f2[i] = row[row.length - 1] + row.slice(0, -1);
  }
  return f2;
}

/**
 * Pick a unique sprite + color for an agent and render two animation frames.
 * Returns [frame1svg, frame2svg, animSpeed].
 */
function generatePixelSprites(agentId: string): [string, string, number] {
  const seed = hashStr(agentId);
  const sprite = SPRITES[seed % SPRITES.length];
  const [primary, accent] = SPRITE_COLORS[(seed * 7 + 3) % SPRITE_COLORS.length];

  const frame1 = spriteToSvg(sprite, primary, accent);
  const frame2 = spriteToSvg(generateFrame2(sprite), primary, accent);
  // Each sprite gets a slightly different toggle speed (500–900ms)
  const speed = 500 + (seed % 5) * 100;

  return [frame1, frame2, speed];
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface CartridgeCardProps {
  agent: Agent;
  siblingAgents?: Agent[];
  activities: Activity[];
  permissions: PermissionRequest[];
  stuckAlert?: StuckAlert;
  onDecidePermission: (id: string, decision: 'allowed' | 'denied', response?: Record<string, unknown>) => void;
  onSetMode: (agentId: string, mode: AgentMode) => void;
  onSendCommand: (agentId: string, text: string, includeMemory?: boolean) => void;
  onDelete: (agentId: string) => void;
  onDismissStuck: (agentId: string) => void;
  onActivityClick?: (activity: Activity) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_CONFIG = {
  working: { color: 'bg-green-500', label: 'Working' },
  idle: { color: 'bg-gray-500', label: 'Idle' },
  waiting: { color: 'bg-yellow-500', label: 'Waiting' },
  offline: { color: 'bg-red-500', label: 'Offline' },
} as const;

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function shortMachine(machine: string): string {
  return machine.replace(/\.local$/, '');
}

/** Truncate a tool input/result to a brief description for the terminal view. */
function briefSummary(activity: Activity): string {
  const { toolName, toolInput } = activity;
  if (!toolInput) return toolName || activity.eventType;

  try {
    const parsed = typeof toolInput === 'string' ? JSON.parse(toolInput) : toolInput;

    // Common tool patterns
    if (parsed.file_path) {
      const file = String(parsed.file_path).split('/').pop();
      return file || toolName;
    }
    if (parsed.command) {
      const cmd = String(parsed.command);
      return cmd.length > 40 ? cmd.slice(0, 37) + '...' : cmd;
    }
    if (parsed.pattern) return String(parsed.pattern);
    if (parsed.query) return String(parsed.query).slice(0, 40);
    if (parsed.url) return String(parsed.url).slice(0, 40);
  } catch {
    // Not JSON — use raw
    const raw = String(toolInput);
    return raw.length > 40 ? raw.slice(0, 37) + '...' : raw;
  }

  return toolName || activity.eventType;
}

// ---------------------------------------------------------------------------
// QuestionAnswerCard — for AskUserQuestion permissions
// ---------------------------------------------------------------------------

function QuestionAnswerCard({ permission, onDecide }: {
  permission: PermissionRequest;
  onDecide: (id: string, decision: 'allowed' | 'denied', response?: Record<string, unknown>) => void;
}) {
  type QuestionOption = { label: string; description?: string } | string;
  type Question = { id?: string; question: string; header?: string; options?: QuestionOption[]; multiSelect?: boolean };

  function normalizeQuestion(raw: unknown): Question | null {
    if (!raw || typeof raw !== 'object') return null;
    const q = raw as Record<string, unknown>;
    const questionText = typeof q.question === 'string'
      ? q.question.trim()
      : typeof q.prompt === 'string'
        ? q.prompt.trim()
        : '';
    if (!questionText) return null;
    return {
      id: typeof q.id === 'string' ? q.id : undefined,
      question: questionText,
      header: typeof q.header === 'string' ? q.header : undefined,
      options: Array.isArray(q.options) ? q.options as QuestionOption[] : undefined,
      multiSelect: Boolean(q.multiSelect),
    };
  }

  function parseQuestions(toolInput: PermissionRequest['toolInput']): Question[] {
    try {
      const input = typeof toolInput === 'string' ? JSON.parse(toolInput) : toolInput;
      if (!input || typeof input !== 'object') return [];
      const parsed = input as Record<string, unknown>;
      if (Array.isArray(parsed.questions)) {
        return parsed.questions.map(normalizeQuestion).filter((q): q is Question => q !== null);
      }
      const single = normalizeQuestion(parsed);
      return single ? [single] : [];
    } catch {
      return [];
    }
  }

  function questionKey(question: Question, index: number): string {
    const id = question.id?.trim();
    if (id) return id;
    const text = question.question.trim();
    if (text) return text;
    return String(index);
  }

  function normalizeOption(option: QuestionOption): { label: string; description?: string } {
    if (typeof option === 'string') return { label: option };
    return { label: option.label || '', description: option.description };
  }

  const questions = parseQuestions(permission.toolInput);
  const isMulti = questions.length > 1 || questions.some((q) => q.multiSelect);

  const [selections, setSelections] = useState<Record<string, string | string[]>>({});
  const [customTexts, setCustomTexts] = useState<Record<string, string>>({});
  const [showCustom, setShowCustom] = useState<Record<string, boolean>>({});

  const handleSelect = (qi: number, label: string) => {
    const q = questions[qi];
    if (!q) return;
    const key = questionKey(q, qi);

    if (q.multiSelect) {
      setSelections((prev) => {
        const existing = (prev[key] as string[]) || [];
        return { ...prev, [key]: existing.includes(label) ? existing.filter((l) => l !== label) : [...existing, label] };
      });
    } else if (isMulti) {
      setSelections((prev) => ({ ...prev, [key]: label }));
    } else {
      onDecide(permission.id, 'allowed', { answers: { [key]: label } });
    }
  };

  const handleSubmit = () => {
    const answers: Record<string, string> = {};
    questions.forEach((q, qi) => {
      const key = questionKey(q, qi);
      if (showCustom[key] && customTexts[key]?.trim()) {
        answers[key] = customTexts[key].trim();
      } else {
        const sel = selections[key];
        answers[key] = Array.isArray(sel) ? sel.join(', ') : (sel as string) || '';
      }
    });
    onDecide(permission.id, 'allowed', { answers });
  };

  if (questions.length === 0) {
    return (
      <div className="bg-yellow-950/40 border border-yellow-700 rounded px-3 py-2">
        <div className="flex items-center gap-2 mb-1">
          <div className="w-2 h-2 bg-yellow-400 animate-pulse" style={{ imageRendering: 'pixelated' }} />
          <span className="text-yellow-300 text-xs font-semibold">Question from Agent</span>
        </div>
        <p className="text-xs text-gray-400">{permission.description}</p>
      </div>
    );
  }

  return (
    <div className="bg-yellow-950/40 border border-yellow-700 rounded px-3 py-2 space-y-2">
      <div className="flex items-center gap-2">
        <div className="w-2 h-2 bg-yellow-400 animate-pulse" style={{ imageRendering: 'pixelated' }} />
        <span className="text-yellow-300 text-xs font-semibold">Question from Agent</span>
      </div>
      {questions.map((q, qi) => {
        const key = questionKey(q, qi);
        const sel = selections[key];
        return (
          <div key={qi}>
            {q.header && <div className="text-[13px] text-gray-500 uppercase mb-0.5">{q.header}</div>}
            <p className="text-xs text-gray-300 mb-1.5">{q.question}</p>
            {q.options && q.options.length > 0 && !showCustom[key] && (
              <div className="flex flex-wrap gap-1">
                {q.options.map((rawOpt, oi) => {
                  const opt = normalizeOption(rawOpt);
                  if (!opt.label) return null;
                  const isSelected = q.multiSelect
                    ? ((sel as string[]) || []).includes(opt.label)
                    : sel === opt.label;
                  return (
                    <button
                      key={oi}
                      onClick={() => handleSelect(qi, opt.label)}
                      className={`px-2 py-1 text-xs rounded transition-colors border ${
                        isSelected
                          ? 'bg-yellow-700/80 text-yellow-100 border-yellow-600'
                          : 'bg-yellow-900/60 hover:bg-yellow-800/80 text-yellow-200 border-yellow-700/50'
                      }`}
                      title={opt.description || ''}
                    >
                      {opt.label}
                    </button>
                  );
                })}
                <button
                  onClick={() => setShowCustom((prev) => ({ ...prev, [key]: true }))}
                  className="px-2 py-1 text-xs rounded transition-colors border bg-gray-800/60 hover:bg-gray-700/60 text-gray-400 border-gray-700/50"
                >
                  Other...
                </button>
              </div>
            )}
            {showCustom[key] && (
              <div className="flex gap-1">
                <input
                  type="text"
                  value={customTexts[key] || ''}
                  onChange={(e) => setCustomTexts((prev) => ({ ...prev, [key]: e.target.value }))}
                  placeholder="Type your answer..."
                  className="flex-1 glass-input text-gray-300 text-xs rounded px-2 py-1 focus:outline-none"
                  onKeyDown={(e) => { if (e.key === 'Enter' && !isMulti) handleSubmit(); }}
                  autoFocus
                />
                <button
                  onClick={() => setShowCustom((prev) => ({ ...prev, [key]: false }))}
                  className="text-gray-500 hover:text-gray-300 text-[13px] px-1.5"
                >
                  Back
                </button>
              </div>
            )}
          </div>
        );
      })}
      {isMulti && (
        <button
          onClick={handleSubmit}
          className="px-3 py-1 bg-yellow-700 hover:bg-yellow-600 text-white text-xs rounded transition-colors font-medium"
        >
          Submit Answers
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PlanApprovalCard — for ExitPlanMode permissions
// ---------------------------------------------------------------------------

function PlanApprovalCard({ permission, onDecide }: {
  permission: PermissionRequest;
  onDecide: (id: string, decision: 'allowed' | 'denied', response?: Record<string, unknown>) => void;
}) {
  const [showReject, setShowReject] = useState(false);
  const [feedback, setFeedback] = useState('');

  let allowedPrompts: { tool: string; prompt: string }[] = [];
  try {
    const input = typeof permission.toolInput === 'string' ? JSON.parse(permission.toolInput) : permission.toolInput;
    allowedPrompts = input?.allowedPrompts || [];
  } catch { /* ignore */ }

  return (
    <div className="bg-violet-950/40 border border-violet-700 rounded px-3 py-2">
      <div className="flex items-center gap-2 mb-1.5">
        <div className="w-2 h-2 bg-violet-400 animate-pulse" style={{ imageRendering: 'pixelated' }} />
        <span className="text-violet-300 text-xs font-semibold">Plan Ready for Review</span>
      </div>
      {allowedPrompts.length > 0 && (
        <div className="mb-2 space-y-0.5">
          <span className="text-[13px] text-gray-500 uppercase tracking-wide">Requested permissions:</span>
          {allowedPrompts.map((p, i) => (
            <div key={i} className="text-xs text-gray-400 font-mono pl-2 border-l border-violet-800">
              {p.tool}: {p.prompt}
            </div>
          ))}
        </div>
      )}
      {showReject ? (
        <div className="space-y-1.5">
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="What should be changed? (optional)"
            className="w-full glass-input text-gray-300 text-xs rounded px-2 py-1.5 resize-none h-14 focus:outline-none"
            autoFocus
          />
          <div className="flex gap-1.5">
            <button
              onClick={() => {
                onDecide(permission.id, 'denied', feedback.trim() ? { feedback: feedback.trim() } : undefined);
              }}
              className="px-2.5 py-1 bg-red-800 hover:bg-red-700 active:bg-red-600 text-white text-xs rounded transition-colors font-medium"
            >
              Confirm Reject
            </button>
            <button
              onClick={() => setShowReject(false)}
              className="px-2.5 py-1 text-gray-500 hover:text-gray-300 text-xs"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => onDecide(permission.id, 'allowed')}
            className="px-2.5 py-1 bg-green-700 hover:bg-green-600 active:bg-green-500 text-white text-xs rounded transition-colors font-medium"
          >
            Approve Plan
          </button>
          <button
            onClick={() => setShowReject(true)}
            className="px-2.5 py-1 bg-red-800 hover:bg-red-700 active:bg-red-600 text-white text-xs rounded transition-colors font-medium"
          >
            Reject Plan
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// InlinePermission — generic Allow/Deny for regular tool permissions
// ---------------------------------------------------------------------------

function InlinePermission({ permission, onAllow, onDeny }: {
  permission: PermissionRequest;
  onAllow: () => void;
  onDeny: () => void;
}) {
  return (
    <div className="flex items-center justify-between bg-gray-800 rounded px-3 py-1.5 gap-2">
      <div className="flex-1 min-w-0">
        <span className="text-yellow-400 text-xs font-mono">{permission.toolName}</span>
        <p className="text-gray-400 text-xs font-mono truncate" title={permission.description}>
          {permission.description}
        </p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={onAllow}
          className="px-2.5 py-1 bg-green-700 hover:bg-green-600 active:bg-green-500 text-white text-xs rounded transition-colors font-medium"
        >
          Allow
        </button>
        <button
          onClick={onDeny}
          className="px-2.5 py-1 bg-red-800 hover:bg-red-700 active:bg-red-600 text-white text-xs rounded transition-colors font-medium"
        >
          Deny
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// CartridgeCard
// ---------------------------------------------------------------------------

export function CartridgeCard({
  agent,
  siblingAgents,
  activities,
  permissions,
  stuckAlert,
  onDecidePermission,
  onSetMode,
  onSendCommand,
  onDelete,
  onDismissStuck,
  onActivityClick,
}: CartridgeCardProps) {
  // ---------------------------------------------------------------------------
  // Client-side status: "working" if ANY activity in the feed is < 120s old.
  // This overrides the server status so the dashboard always reflects reality.
  // ---------------------------------------------------------------------------
  const ACTIVE_WINDOW_MS = 120_000; // 2 minutes
  const [tick, setTick] = useState(Date.now());

  // Re-evaluate every 15s so status transitions even when no new events arrive
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  const effectiveStatus = useMemo(() => {
    // Always respect waiting (pending question) and offline
    if (agent.status === 'waiting') return 'waiting' as const;
    if (agent.status === 'offline') {
      // Even offline can be overridden if we actually have fresh activity
      const hasRecent = activities.some(
        (a) => tick - new Date(a.timestamp).getTime() < ACTIVE_WINDOW_MS,
      );
      if (hasRecent) return 'working' as const;
      return 'offline' as const;
    }

    const hasRecentActivity = activities.some(
      (a) => tick - new Date(a.timestamp).getTime() < ACTIVE_WINDOW_MS,
    );
    if (hasRecentActivity) return 'working' as const;
    return agent.status;
  }, [agent.status, activities, tick, ACTIVE_WINDOW_MS]);

  const status = STATUS_CONFIG[effectiveStatus];

  const [frame1, frame2, animSpeed] = useMemo(() => generatePixelSprites(agent.id), [agent.id]);
  const [spriteFrame, setSpriteFrame] = useState(0);

  // 2-frame retro sprite animation (like Space Invaders)
  useEffect(() => {
    const id = setInterval(() => setSpriteFrame((f) => (f === 0 ? 1 : 0)), animSpeed);
    return () => clearInterval(id);
  }, [animSpeed]);

  const pixelBg = spriteFrame === 0 ? frame1 : frame2;
  const [gitOpen, setGitOpen] = useState(false);
  const [journalOpen, setJournalOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);


  // Take last 8 activities for the terminal
  const terminalActivities = activities.slice(0, 8);

  // Cartridge border highlight for special states
  const borderHighlight = stuckAlert
    ? 'border-amber-600/70'
    : effectiveStatus === 'waiting'
      ? 'border-yellow-700/60'
      : 'border-white/[0.08]';

  return (
    <div className="relative flex flex-col">
      {/* ── Contact strip (top connector) ── */}
      <div
        className="mx-auto w-[60%] h-4 rounded-t-sm relative"
        style={{
          background: 'linear-gradient(180deg, #2a2a3e 0%, #1a1a2e 100%)',
          borderLeft: '1px solid rgba(255,255,255,0.06)',
          borderRight: '1px solid rgba(255,255,255,0.06)',
          borderTop: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        {/* Contact lines */}
        <div className="absolute inset-x-2 top-1 bottom-0 flex justify-between">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="w-[2px] h-full"
              style={{ background: 'rgba(168,85,247,0.25)' }}
            />
          ))}
        </div>
      </div>

      {/* ── Main cartridge body ── */}
      <div
        className={`glass rounded-lg border ${borderHighlight} flex flex-col transition-colors`}
        style={{
          borderTopLeftRadius: '2px',
          borderTopRightRadius: '2px',
        }}
      >
        {/* ── Sticker area ── */}
        <div
          className="mx-3 mt-3 mb-2 rounded p-3 relative overflow-hidden"
          style={{
            background: 'linear-gradient(135deg, rgba(168,85,247,0.25) 0%, rgba(236,72,153,0.2) 50%, rgba(59,130,246,0.15) 100%)',
            boxShadow: '0 0 0 2px #a855f7, 4px 4px 0 0 rgba(0,0,0,0.3)',
            imageRendering: 'pixelated',
          }}
        >
          {/* Pixel art background */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              backgroundImage: `url("${pixelBg}")`,
              backgroundSize: 'contain',
              backgroundPosition: 'center',
              backgroundRepeat: 'no-repeat',
              imageRendering: 'pixelated',
              opacity: 0.12,
            }}
          />
          {/* Top row: repo name + controls */}
          <div className="flex items-start justify-between mb-1.5">
            <h3 className="font-pixel text-xs text-white leading-relaxed tracking-wide truncate flex-1 mr-2">
              {agent.repoName || 'UNKNOWN'}
            </h3>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                onClick={() => setJournalOpen(true)}
                className="text-gray-400 hover:text-cyan-400 transition-colors"
                title="Project journal & session memory"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25" />
                </svg>
              </button>
              <button
                onClick={() => setGitOpen(true)}
                className="text-gray-400 hover:text-gl-purple transition-colors"
                title="Git worktrees & status"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                  <circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M6 21V9a9 9 0 0 0 9 9h6" />
                </svg>
              </button>
              <button
                onClick={() => setContextOpen(true)}
                className="text-gray-400 hover:text-gl-purple transition-colors"
                title="Send project context to agent"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
                </svg>
              </button>
              <button
                onClick={() => api.focusAgent(agent.id).catch(() => {})}
                className="text-gray-400 hover:text-gl-purple transition-colors text-xs font-bold"
                title="Bring VS Code window to front"
              >
                ^
              </button>
              <button
                onClick={() => onDelete(agent.id)}
                className="text-gray-400 hover:text-red-400 transition-colors text-xs font-bold"
                title="Remove agent"
              >
                x
              </button>
            </div>
          </div>

          {/* Branch */}
          <div className="text-[13px] text-gray-300 mb-1 font-mono">
            Branch: {agent.branch || 'n/a'}
          </div>

          {/* Status row */}
          <div className="flex items-center gap-2 mb-1">
            {/* Pixel status dot (square) */}
            <div
              className={`w-2 h-2 ${status.color} ${effectiveStatus === 'working' || effectiveStatus === 'waiting' ? 'animate-pulse' : ''}`}
              style={{ imageRendering: 'pixelated' }}
            />
            <span className="text-[13px] text-gray-200">{status.label}</span>
            <span className="text-[13px] text-gray-500">{timeAgo(agent.lastSeen)}</span>
          </div>

          {/* Agent type badges + machine */}
          <div className="flex items-center gap-2">
            <span className={`text-[13px] px-1.5 py-0.5 rounded font-medium tracking-wide ${
              agent.agentType === 'gridlight'
                ? 'bg-pink-900/60 text-pink-300'
                : 'bg-blue-900/60 text-blue-300'
            }`}>
              {agent.agentType === 'gridlight' ? 'Gridlight' : 'Claude CC'}
            </span>
            {siblingAgents?.map((s) => (
              <span key={s.id} className={`text-[13px] px-1.5 py-0.5 rounded font-medium tracking-wide ${
                s.agentType === 'gridlight'
                  ? 'bg-pink-900/60 text-pink-300'
                  : 'bg-blue-900/60 text-blue-300'
              }`}>
                {s.agentType === 'gridlight' ? 'Gridlight' : 'Claude CC'}
              </span>
            ))}
            <span className="text-[13px] text-gray-500 font-mono truncate">
              {shortMachine(agent.machine)}
            </span>
          </div>
        </div>

        {/* ── Stuck alert ── */}
        {stuckAlert && (
          <div className="mx-3 mb-2 bg-amber-950/40 border border-amber-800 rounded px-3 py-2">
            <div className="flex items-start justify-between gap-2 mb-1">
              <div className="flex items-center gap-1.5">
                <span className="text-amber-400 text-xs font-bold">!</span>
                <span className="text-amber-300 text-xs font-semibold">
                  {stuckAlert.severity === 'high' ? 'Stuck' : 'Possibly stuck'}
                </span>
              </div>
              <button
                onClick={() => onDismissStuck(agent.id)}
                className="text-gray-500 hover:text-gray-300 text-[13px]"
              >
                dismiss
              </button>
            </div>
            <p className="text-xs text-gray-400 mb-1.5">{stuckAlert.pattern}</p>
            <button
              onClick={() => onSendCommand(agent.id, stuckAlert.suggestion)}
              className="px-2 py-0.5 bg-amber-800 hover:bg-amber-700 text-white text-[13px] rounded transition-colors"
            >
              Send Hint
            </button>
          </div>
        )}

        {/* ── Permission cards ── */}
        {permissions.length > 0 && (
          <div className="mx-3 mb-2 space-y-1.5">
            <div className="flex items-center gap-1.5 text-xs text-yellow-400">
              <div className="w-1.5 h-1.5 bg-yellow-500 animate-pulse" />
              Pending ({permissions.length})
            </div>
            {permissions.map((perm) => {
              if (perm.toolName === 'AskUserQuestion') {
                return <QuestionAnswerCard key={perm.id} permission={perm} onDecide={onDecidePermission} />;
              }
              if (perm.toolName === 'ExitPlanMode') {
                return <PlanApprovalCard key={perm.id} permission={perm} onDecide={onDecidePermission} />;
              }
              return (
                <InlinePermission
                  key={perm.id}
                  permission={perm}
                  onAllow={() => onDecidePermission(perm.id, 'allowed')}
                  onDeny={() => onDecidePermission(perm.id, 'denied')}
                />
              );
            })}
          </div>
        )}

        {/* ── Command input ── */}
        <div className="mx-3 mb-2">
          <CommandInput
            agentId={agent.id}
            mode={agent.mode}
            placeholder={effectiveStatus === 'waiting'
              ? 'Answer or instruct...'
              : effectiveStatus === 'offline'
                ? 'Offline - will queue...'
                : 'Send prompt or /command...'}
            onSend={(text) => {
              const planSuffix = agent.mode === 'plan'
                ? '\n\nIMPORTANT: Enter plan mode first. Use the EnterPlanMode tool to create an implementation plan and get my approval before writing any code.'
                : '';
              const finalText = text + planSuffix;
              onSendCommand(agent.id, finalText);
              // Also send to sibling agents (e.g. both Claude and Gridlight for same project)
              if (siblingAgents?.length) {
                for (const s of siblingAgents) {
                  setTimeout(() => onSendCommand(s.id, finalText), 5000);
                }
              }
            }}
          />
        </div>


        {/* ── Mode selector ── */}
        <div className="mx-3 mb-2 flex items-center justify-between">
          <AgentModeSelector mode={agent.mode} onSetMode={(mode) => onSetMode(agent.id, mode)} />
        </div>

        {/* ── Terminal: recent activity ── */}
        <div
          className="mx-3 mb-3 rounded overflow-hidden"
          style={{
            backgroundColor: '#0d0d14',
            border: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          <div className="px-2 py-1 flex items-center justify-between" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
            <span className="text-[13px] text-gray-500 uppercase tracking-wider font-mono">Activity</span>
            <span className="text-[13px] text-gray-600 font-mono">{activities.length} events</span>
          </div>
          <div
            className="overflow-y-auto font-mono text-[13px] leading-relaxed"
            style={{ maxHeight: '120px' }}
          >
            {terminalActivities.length === 0 ? (
              <div className="px-2 py-3 text-gray-600 text-center text-[13px]">
                No activity yet
              </div>
            ) : (
              terminalActivities.map((act) => (
                <div
                  key={act.id}
                  onClick={() => onActivityClick?.(act)}
                  className="px-2 py-0.5 hover:bg-white/[0.04] cursor-pointer truncate transition-colors text-green-400"
                  title={`${act.toolName || act.eventType}: ${act.toolInput || ''}`}
                >
                  <span className="text-green-600 select-none">&gt; </span>
                  <span className="text-green-500">{act.toolName || act.eventType}</span>
                  {' '}
                  <span className="text-green-400/60">{briefSummary(act)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Git Panel Modal */}
      {gitOpen && <GitPanel agent={agent} onClose={() => setGitOpen(false)} />}

      {/* Journal / Session Memory Modal */}
      {journalOpen && agent.repoName && (
        <ProjectMemoryPanel project={agent.repoName} onClose={() => setJournalOpen(false)} />
      )}

      {/* Send Context Modal */}
      {contextOpen && agent.repoName && (
        <SendContextModal agentId={agent.id} project={agent.repoName} onClose={() => setContextOpen(false)} />
      )}
    </div>
  );
}

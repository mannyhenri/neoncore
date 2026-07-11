// NeonCore mobile theme — mirrors the dashboard's retro-neon palette
// (near-black backgrounds, violet accent, amber/teal/pink status hues).
export const theme = {
  bg: '#0d0f12',
  bgElevated: '#14161c',
  bgCard: '#1a1a2e',
  border: '#2a2a3e',
  text: '#f4f4f8',
  textDim: '#9aa0ab',
  textFaint: '#5c626e',

  accent: '#a855f7', // violet — primary
  accentSoft: '#c084fc',
  amber: '#f59e0b',
  pink: '#ec4899',
  teal: '#55efc4',
  blue: '#3b82f6',
  danger: '#ff6b6b',
} as const;

export type AgentStatus = 'working' | 'idle' | 'waiting' | 'offline';

export const statusColor: Record<AgentStatus, string> = {
  working: theme.teal,
  waiting: theme.amber,
  idle: theme.textDim,
  offline: theme.textFaint,
};

export const statusLabel: Record<AgentStatus, string> = {
  working: 'WORKING',
  waiting: 'WAITING',
  idle: 'IDLE',
  offline: 'OFFLINE',
};

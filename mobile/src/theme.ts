// NeonCore mobile theme — mirrors the dashboard's retro-neon palette
// (near-black backgrounds, violet accent, amber/teal/pink status hues).
export const theme = {
  /**
   * The one way a mobile screen titles itself. The list screen used 26/800 while every other
   * screen used 16/700, and the queue screen had no title at all — three different answers to
   * one question, none of them chosen.
   */
  screenTitle: { fontSize: 20, fontWeight: '700' as const, letterSpacing: 0.2 },
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

  /**
   * Semantic roles. These exist because the screens invented them anyway: `'#f87171'` was
   * shipping next to `danger`, `'#fbbf24'` next to `amber`, and `'#34d399'` had no token at
   * all. Two literals for one role is two colours, and nobody chose the second one.
   */
  success: '#34d399',      // a finished item, a passing run
  warn: '#fbbf24',         // halted, blocked — stopped and waiting on a human
  warnSoft: '#fde68a',     // warn text on a warn-tinted surface
  dangerSoft: '#fecaca',   // danger text on a danger-tinted surface
  onAccent: '#ffffff',     // text sitting ON an accent fill, never on the background
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

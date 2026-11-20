// NeonCore mobile theme — NIGHT GLASS, the dashboard's look (docs/DESIGN.md → Tokens).
//
// Near-black page, dark glass panels with thin blue-grey borders, ONE accent — neon blue — on
// whatever is live or selected, and ember orange for "needs you". The retired look (violet
// accent, pink wordmark, teal "working", purple-tinted cards) is gone, and so are its token
// names, so no screen can reach for them: src/__tests__/night-glass.test.ts.
export const theme = {
  /**
   * The one way a mobile screen titles itself. The list screen used 26/800 while every other
   * screen used 16/700, and the queue screen had no title at all — three different answers to
   * one question, none of them chosen.
   */
  screenTitle: { fontSize: 20, fontWeight: '700' as const, letterSpacing: 0.2 },
  bg: '#04060C',           // the page (web: bg-ink)
  bgElevated: '#0A1020',   // bars, sheets, dialogs (web: .glass-dark)
  bgCard: '#0B1120',       // a card (web: .glass-light, rgba(14,20,36,.62) over the page)
  bgWell: '#050913',       // inputs, code and log wells (web: bg-gl-code)
  border: '#19213A',       // thin blue-grey (web: rgba(120,150,255,.14) over the page)
  borderStrong: '#27325A', // a dialog's edge (web: rgba(120,150,255,.22))
  text: '#E8EEFF',
  textDim: '#A9B5D3',
  textFaint: '#8A97B8',

  accent: '#5AAEFF',       // neon — live, selected, primary
  accentSoft: '#9CCBFF',
  ember: '#FF8A3D',        // needs you
  danger: '#FF6B6B',

  /**
   * Semantic roles. These exist because the screens invented them anyway: two literals for one
   * role is two colours, and nobody chose the second one.
   */
  success: '#4ADE80',      // a finished item, a passing run
  warn: '#FF8A3D',         // halted, blocked — stopped and waiting on a human: that IS "needs you"
  warnSoft: '#FFC9A3',     // warn text on a warn-tinted surface
  dangerSoft: '#FFC2C2',   // danger text on a danger-tinted surface
  onAccent: '#04060C',     // text sitting ON an accent fill, never on the background

  /** Tints: a role's colour at low strength, for the surface behind its text. */
  accentTint: 'rgba(90,174,255,0.12)',
  emberTint: 'rgba(255,138,61,0.12)',
  emberEdge: 'rgba(255,138,61,0.32)',
  emberFill: 'rgba(255,138,61,0.2)',
  dangerTint: 'rgba(255,107,107,0.12)',
  dangerEdge: 'rgba(255,107,107,0.32)',
  dangerFill: 'rgba(255,107,107,0.2)',
  successTint: 'rgba(74,222,128,0.16)',
  successEdge: 'rgba(74,222,128,0.4)',
  scrim: 'rgba(0,0,0,0.6)',

  /** Engines — pills and dots only (docs/DESIGN.md). */
  engine: { claude: '#7CC4FF', codex: '#2EE6D6' } as Record<string, string>,
} as const;

/**
 * THE GLOW. What is live glows; nothing else does. iOS draws it as a shadow in the role's
 * colour (Android has no coloured shadow and simply shows the colour).
 */
export const glow = (color: string = theme.accent, radius = 6) => ({
  shadowColor: color, shadowOpacity: 0.9, shadowRadius: radius, shadowOffset: { width: 0, height: 0 },
});

export type AgentStatus = 'working' | 'idle' | 'waiting' | 'offline';

export const statusColor: Record<AgentStatus, string> = {
  working: theme.accent,
  waiting: theme.ember,
  idle: theme.textDim,
  offline: theme.textFaint,
};

export const statusLabel: Record<AgentStatus, string> = {
  working: 'WORKING',
  waiting: 'WAITING',
  idle: 'IDLE',
  offline: 'OFFLINE',

};

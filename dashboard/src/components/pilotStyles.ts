/** Shared look of the Goal Pilot panel and its acceptance contract (GoalPilotPanel, AcceptanceContractPanel). */
export const ENGINE_LABEL: Record<string, string> = {
  claude: 'Claude Code', codex: 'Codex', gridlight: 'Gridlight',
};

export const input = 'w-full bg-black/30 border border-white/10 rounded-md px-2.5 py-1.5 text-[13px] text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500/60';
export const primaryBtn = 'px-3 py-1.5 text-xs text-white bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-md transition-colors font-medium';
export const quietBtn = 'px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 border border-white/10 hover:border-white/20 rounded-md transition-colors disabled:opacity-40';
export const dangerBtn = 'px-3 py-1.5 text-xs text-amber-100 bg-amber-700/60 hover:bg-amber-600/70 disabled:opacity-40 rounded-md transition-colors font-medium';

export function errorText(e: unknown): string {
  return (e as Error)?.message || 'something went wrong';
}

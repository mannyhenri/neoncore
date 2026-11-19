/** Shared look of the Goal Pilot panel and its acceptance contract (GoalPilotPanel, AcceptanceContractPanel). */
export const ENGINE_LABEL: Record<string, string> = {
  claude: 'Claude Code', codex: 'Codex', gridlight: 'Gridlight',
};

export const input = 'w-full glass-input rounded-[10px] px-3 py-2 text-[14px] text-gray-100 placeholder-gray-500';
/** The pilot's own accent — Night Glass violet (#7C6CFF), distinct from the neon blue of runs. */
export const primaryBtn = 'h-10 px-4 text-[13px] text-[#E4DFFF] border border-[rgba(124,108,255,0.7)] bg-[rgba(124,108,255,0.22)] hover:bg-[rgba(124,108,255,0.32)] disabled:opacity-40 disabled:cursor-not-allowed rounded-[10px] transition-colors font-semibold';
export const quietBtn = 'h-10 px-3.5 text-[13px] text-gray-100 btn-ghost rounded-[10px] transition-colors font-semibold disabled:opacity-40';
export const dangerBtn = 'h-10 px-3.5 text-[13px] text-red-200 border border-red-400/45 hover:bg-red-500/10 disabled:opacity-40 rounded-[10px] transition-colors font-semibold';

export function errorText(e: unknown): string {
  return (e as Error)?.message || 'something went wrong';
}

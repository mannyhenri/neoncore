export const CODEX_FULL_ACCESS_FLAG = '--dangerously-bypass-approvals-and-sandbox';

function isSyntheticSessionId(sessionId) {
  return /^(relay|neoncore|remote)-/.test(sessionId);
}

export function codexArgsForMode(baseArgs, mode, sessionId = '') {
  const args = baseArgs.filter((arg) => arg !== CODEX_FULL_ACCESS_FLAG);
  const resumeIndex = args.indexOf('resume');
  const withoutResume = resumeIndex === -1
    ? args
    : [...args.slice(0, resumeIndex), ...args.slice(resumeIndex + 2)];
  const modeArgs = mode === 'trust' ? [CODEX_FULL_ACCESS_FLAG, ...withoutResume] : withoutResume;
  return sessionId && !isSyntheticSessionId(sessionId)
    ? [...modeArgs, 'resume', sessionId]
    : modeArgs;
}

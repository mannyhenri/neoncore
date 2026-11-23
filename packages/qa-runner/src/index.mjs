/**
 * @neoncore/qa-runner — plays QA tests' cached actions in Chromium with no AI
 * (docs/plans/qa-section.md § Runner CLI). The server imports this or spawns cli.mjs.
 */
export { runSpec, actSpec, runSpecProblem } from './run.mjs';
export { snapshot } from './snapshot.mjs';
export { isCheckSentence, invalidAction, ACTION_KINDS, EXPECT_KINDS, LOCATOR_KEYS, MAX_WAIT_MS } from './actions.mjs';
export { DEFAULT_DENY, deniedBy, hostAllowed } from './guard.mjs';
export { scrubZip, zipTexts } from './zip.mjs';

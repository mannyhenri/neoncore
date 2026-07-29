import type { Agent } from './types';

/**
 * Should the cartridge show the "stopped without a completion report" banner?
 *
 * Lives in its own module rather than inline in the screen so the rule is testable without
 * a React Native environment — the screen imports it, the test imports it, and there is one
 * definition of the rule instead of two that can drift.
 *
 * Absent is not flagged: a federated peer running an older server build sends no
 * `standardState` at all, and "I don't know" must read as "fine" rather than as a warning
 * on every cartridge served by an older machine.
 */
export function needsStandardReview(agent: Pick<Agent, 'standardState'> | undefined | null): boolean {
  return agent?.standardState === 'needs_review';
}

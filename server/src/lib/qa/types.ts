/**
 * THE QA SECTION'S SHARED SHAPES — docs/plans/qa-section.md is the contract; this mirrors it.
 *
 * A test is plain-language sentences. Its cache is `QaAction[][]`, one list per sentence, which
 * the runner (packages/qa-runner) interprets — never code. A cartridge writes a cache the first
 * time and repairs one step when the page changed; every other run replays it with no AI at all.
 */

export interface Locator {
  role?: string; name?: string; label?: string; text?: string; placeholder?: string; testId?: string; css?: string;
}

export const EXPECT_KINDS = ['visible', 'hidden', 'text', 'url', 'value', 'count'] as const;
export type ExpectKind = (typeof EXPECT_KINDS)[number];

export type QaAction =
  | { do: 'goto'; path: string }
  | { do: 'click'; target: Locator }
  | { do: 'fill'; target: Locator; value?: string; valueEnv?: string }
  | { do: 'select'; target: Locator; option: string }
  | { do: 'check'; target: Locator; checked: boolean }
  | { do: 'press'; key: string }
  | { do: 'wait'; ms: number }
  | { do: 'expect'; kind: ExpectKind; target?: Locator; equals?: string | number; contains?: string };

export const ACTION_KINDS = ['goto', 'click', 'fill', 'select', 'check', 'press', 'wait', 'expect'] as const;

export const RUN_KINDS = ['run', 'explore', 'generate'] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export type RunStatus = 'running' | 'waiting' | 'passed' | 'passed_with_repair' | 'failed' | 'completed' | 'error';
export type ResultStatus = 'pending' | 'authoring' | 'repairing' | 'passed' | 'passed_with_repair' | 'failed';

export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const REQUEST_KINDS = ['author', 'repair', 'explore'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

/** A check sentence asserts something; its cached actions must contain at least one `expect`. */
export function isCheckSentence(sentence: string): boolean {
  return /^\s*(\d+[.)]\s*)?(check|verify|ensure|confirm|expect|assert)\b/i.test(sentence);
}

/** What the runner reports for one replay (packages/qa-runner `run`). */
export interface RunnerStep {
  index: number; sentence: string; status: 'passed' | 'failed' | 'skipped';
  error?: string; failedAction?: unknown; screenshot?: string;
}
export interface RunnerResult {
  status: 'passed' | 'failed' | 'blocked';
  steps: RunnerStep[];
  console: string[];
  network: { url: string; status: number; method: string }[];
  trace: string;
  durationMs: number;
  error?: string;
}

export interface RunnerSpec {
  baseUrl: string;
  allowHosts: string[];
  denyActions: string[];
  allowDestructive?: boolean;
  env?: string[];
  sentences: string[];
  cache: QaAction[][];
  budget?: { minutes?: number };
}

export class QaError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

/** Default destructive-action patterns (the contract's deny-list). */
export const DEFAULT_DENY = ['delete', 'remove', 'pay', 'purchase', 'send email', 'unsubscribe'];

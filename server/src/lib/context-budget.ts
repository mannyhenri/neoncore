/**
 * Context size budgets — hard caps on every component injected into agent prompts.
 * Prevents unbounded context growth and keeps prompts lean.
 */

// Memory injection
export const MEMORY_MAX_ITEMS = 5;
export const MEMORY_ITEM_MAX_CHARS = 150;
export const MEMORY_MAX_TOTAL_CHARS = 800;

// Session summaries (in project context)
export const SESSION_SUMMARY_MAX_CHARS = 400;
export const SESSION_COUNT = 2;

// Knowledge files (per file)
export const KNOWLEDGE_FILE_MAX_CHARS = 500;

// Notes (in project context)
export const NOTES_MAX_CHARS = 500;

// Total assembled project context
export const PROJECT_CONTEXT_MAX_CHARS = 2000;

// Workflow dependency results
export const DEP_RESULT_MAX_CHARS = 1500;
export const DEP_TOTAL_MAX_CHARS = 4000;

// The full-run record injected into the terminal Workflow Completion Report step.
// Wider than the dependency budget on purpose: that one carries a handoff between two
// steps, this one is the entire run and is the only thing standing between the report and
// an invented account of it. Still capped — per step so one huge result cannot crowd out
// the rest, and in total so a forty-step run does not blow the prompt.
export const RUN_REPORT_RESULT_MAX_CHARS = 1200;
export const RUN_REPORT_TOTAL_MAX_CHARS = 24000;

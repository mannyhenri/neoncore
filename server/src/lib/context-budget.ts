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

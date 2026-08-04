import Database, { type Database as DatabaseType } from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// NEONCORE_DB_PATH lets a process pick its own database file.
//
// Two reasons this exists, one operational and one for tests:
//   - Federation gives every server its OWN database. Running two on one machine (a
//     second port for staging, or a peer under test) needs two files; without this they
//     would silently share one and stop being independent servers at all.
//   - Tests import modules that hold this singleton. Pointing them at a temp file is what
//     keeps a test run from mutating the real neoncore.db underneath a live server.
const DB_PATH = process.env.NEONCORE_DB_PATH?.trim() || path.join(__dirname, '..', 'neoncore.db');

const db: DatabaseType = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    machine TEXT NOT NULL,
    repo_path TEXT NOT NULL DEFAULT '',
    repo_name TEXT NOT NULL DEFAULT '',
    branch TEXT NOT NULL DEFAULT '',
    current_task TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'idle',
    trust_mode INTEGER NOT NULL DEFAULT 0,
    last_seen TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT '',
    last_message TEXT NOT NULL DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS idx_agents_machine_repo ON agents(machine, repo_path);

  CREATE TABLE IF NOT EXISTS activity (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    tool_name TEXT NOT NULL DEFAULT '',
    tool_input TEXT NOT NULL DEFAULT '{}',
    timestamp TEXT NOT NULL,
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  );

  CREATE TABLE IF NOT EXISTS permissions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    tool_input TEXT NOT NULL DEFAULT '{}',
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    decided_at TEXT,
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  );

  CREATE TABLE IF NOT EXISTS commands (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    text TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'dashboard',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    delivered_at TEXT,
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  );

  CREATE TABLE IF NOT EXISTS agent_memory (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    project TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL,
    content TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL,
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  );

  CREATE INDEX IF NOT EXISTS idx_activity_agent ON activity(agent_id);
  CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON activity(timestamp);
  CREATE INDEX IF NOT EXISTS idx_permissions_status ON permissions(status);
  CREATE INDEX IF NOT EXISTS idx_permissions_agent ON permissions(agent_id);
  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  );

  -- Capability-gated engine routing. TWO tables, not one, because the grain and the
  -- lifetime differ: a profile is per (model_id) and is replaced wholesale by a re-probe;
  -- a demotion is per (model_id, function_id) and accumulates BETWEEN probes as runtime
  -- evidence. Collapsing them would make it impossible to clear evidence on re-measurement
  -- without also discarding the measurement.
  CREATE TABLE IF NOT EXISTS model_capability_profiles (
    model_id TEXT PRIMARY KEY,
    measured_at TEXT NOT NULL,
    profile_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS engine_demotions (
    model_id TEXT NOT NULL,
    function_id TEXT NOT NULL,
    demoted INTEGER NOT NULL DEFAULT 1,
    reason TEXT NOT NULL DEFAULT '',
    demoted_at TEXT NOT NULL,
    -- The streak lives in the table, not in a Map. An in-memory counter resets on every
    -- restart, so two failures + a restart + a third never reaches the threshold and
    -- demotion silently never fires on a server that restarts often.
    failure_streak INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (model_id, function_id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_memory_agent ON agent_memory(agent_id);
  CREATE INDEX IF NOT EXISTS idx_memory_project ON agent_memory(project);
  CREATE INDEX IF NOT EXISTS idx_notes_agent ON notes(agent_id);
`);

// Migration: add agent_mode column
try {
  db.prepare('SELECT agent_mode FROM agents LIMIT 1').get();
} catch {
  db.exec(`
    ALTER TABLE agents ADD COLUMN agent_mode TEXT NOT NULL DEFAULT 'manual';
    UPDATE agents SET agent_mode = CASE WHEN trust_mode = 1 THEN 'trust' ELSE 'manual' END;
  `);
}

// Migration: add agent_type column
try {
  db.prepare('SELECT agent_type FROM agents LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE agents ADD COLUMN agent_type TEXT NOT NULL DEFAULT 'claude'`);
}

// Migration: add composite index for dedup by machine + repo + type
db.exec(`CREATE INDEX IF NOT EXISTS idx_agents_machine_repo_type ON agents(machine, repo_path, agent_type)`);

// Migration: add active column to agent_memory
try {
  db.prepare('SELECT active FROM agent_memory LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE agent_memory ADD COLUMN active INTEGER NOT NULL DEFAULT 1`);
}

// Migration: add tool_result column to activity
try {
  db.prepare('SELECT tool_result FROM activity LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE activity ADD COLUMN tool_result TEXT NOT NULL DEFAULT '{}'`);
}

// Migration: add pending_question column to agents
try {
  db.prepare('SELECT pending_question FROM agents LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE agents ADD COLUMN pending_question TEXT NOT NULL DEFAULT ''`);
}

// Migration: add memory_enabled column to agents
try {
  db.prepare('SELECT memory_enabled FROM agents LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE agents ADD COLUMN memory_enabled INTEGER NOT NULL DEFAULT 0`);
}

// Migration: add response column to permissions (for AskUserQuestion answers, ExitPlanMode feedback)
try {
  db.prepare('SELECT response FROM permissions LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE permissions ADD COLUMN response TEXT NOT NULL DEFAULT ''`);
}

// Migration: add plans_included column to agents
try {
  db.prepare('SELECT plans_included FROM agents LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE agents ADD COLUMN plans_included INTEGER NOT NULL DEFAULT 0`);
}

// Migration: add dismissed_at to agents — "I'm done with this one for now, hide it."
//
// Deliberately a SEPARATE column from `status`, not a new status value. `status` is about
// liveness (is this session alive?); dismissal is about *your view* (do you want to look at
// it?). They are orthogonal — a dismissed cartridge is very often still running.
// Folding them together is precisely the bug that made live cartridges vanish from the grid:
// `offline` had come to mean both "gone quiet" and "hide it". Never again.
try {
  db.prepare('SELECT dismissed_at FROM agents LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE agents ADD COLUMN dismissed_at TEXT`);
}

// Migration: ordinary cartridge recovery state.
//
// Workflow recovery is tracked on workflow_steps. These columns cover the ad hoc
// case: a user is working directly in a cartridge terminal, the machine loses
// power, and they later relaunch the cartridge. We keep the last dashboard
// objective plus a recovery marker so the web app can offer a transcript replay
// without needing a workflow step.
try {
  db.prepare('SELECT recovery_status FROM agents LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE agents ADD COLUMN recovery_status TEXT NOT NULL DEFAULT ''`);
  db.exec(`ALTER TABLE agents ADD COLUMN interrupted_at TEXT`);
  db.exec(`ALTER TABLE agents ADD COLUMN recovery_session_id TEXT NOT NULL DEFAULT ''`);
  db.exec(`ALTER TABLE agents ADD COLUMN active_objective TEXT NOT NULL DEFAULT ''`);
}

// Work-standard gate state (see lib/work-standard.ts and docs/WORK-STANDARD.md).
//
//   standard_armed  — the dispatched prompt carried the standard, so the completion
//                     contract applies to this objective. The Stop gate fires ONLY when
//                     armed, which is what keeps conversational turns out of it.
//   standard_blocks — how many times we have already refused to let this agent stop.
//                     Capped, so a genuinely stuck agent is released rather than pinned.
//   standard_state  — 'needs_review' once released without a completion report: the
//                     half-done state made visible instead of silently accepted.
try {
  db.prepare('SELECT standard_armed FROM agents LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE agents ADD COLUMN standard_armed INTEGER NOT NULL DEFAULT 0`);
  db.exec(`ALTER TABLE agents ADD COLUMN standard_blocks INTEGER NOT NULL DEFAULT 0`);
  db.exec(`ALTER TABLE agents ADD COLUMN standard_state TEXT NOT NULL DEFAULT ''`);
}

// standard_offered — the contract was handed to this agent, but is not binding until it
// edits something (lib/work-standard.ts armOnWork). Separate migration block because the
// columns above already shipped; agents upgraded from that build have them but not this.
try {
  db.prepare('SELECT standard_offered FROM agents LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE agents ADD COLUMN standard_offered INTEGER NOT NULL DEFAULT 0`);
}

// Epic Autopilot table
db.exec(`
  CREATE TABLE IF NOT EXISTS epic_runs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    current_task INTEGER NOT NULL DEFAULT 0,
    tasks TEXT NOT NULL DEFAULT '[]',
    config TEXT NOT NULL DEFAULT '{}',
    previous_mode TEXT NOT NULL DEFAULT 'manual',
    started_at TEXT NOT NULL,
    completed_at TEXT,
    error TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  );

  CREATE INDEX IF NOT EXISTS idx_epic_runs_status ON epic_runs(status);
  CREATE INDEX IF NOT EXISTS idx_epic_runs_agent ON epic_runs(agent_id);
`);

// Workflow table
db.exec(`
  CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    jira_task_id TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    players TEXT NOT NULL DEFAULT '[]',
    phases TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending',
    current_phase INTEGER NOT NULL DEFAULT 0,
    iteration INTEGER NOT NULL DEFAULT 1,
    max_iterations INTEGER NOT NULL DEFAULT 3,
    shared_context TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    started_at TEXT NOT NULL DEFAULT '',
    completed_at TEXT,
    error TEXT NOT NULL DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS idx_workflows_status ON workflows(status);
`);

// Migration: add target_repos to workflows
try {
  db.prepare('SELECT target_repos FROM workflows LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE workflows ADD COLUMN target_repos TEXT NOT NULL DEFAULT '[]'`);
}

// Migration: add template_id and run_number to workflows (multi-run support)
try {
  db.prepare('SELECT template_id FROM workflows LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE workflows ADD COLUMN template_id TEXT DEFAULT NULL`);
  db.exec(`ALTER TABLE workflows ADD COLUMN run_number INTEGER NOT NULL DEFAULT 0`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_workflows_template ON workflows(template_id)`);
}

// Migration: add initial_context column to workflows (user-supplied context passed to first steps)
try {
  db.prepare('SELECT initial_context FROM workflows LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE workflows ADD COLUMN initial_context TEXT NOT NULL DEFAULT ''`);
}

// Migration: add project_id column to workflows (goal cascade)
try {
  db.prepare('SELECT project_id FROM workflows LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE workflows ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_workflows_project ON workflows(project_id)`);
}

// Migration: add attachments column to workflows — files the user attached at launch,
// stored as a repoPath → prompt-block map (see lib/attachments.ts) because a run's steps
// can sit in different repos and each agent needs a path valid in its own checkout.
try {
  db.prepare('SELECT attachments FROM workflows LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE workflows ADD COLUMN attachments TEXT NOT NULL DEFAULT '{}'`);
}

// FTS5 full-text search over session summaries and project knowledge.
// Drop triggers and tables first so we always start from a consistent schema.
try {
  db.exec(`
    DROP TRIGGER IF EXISTS sessions_ai;
    DROP TRIGGER IF EXISTS sessions_au;
    DROP TRIGGER IF EXISTS sessions_ad;
    DROP TRIGGER IF EXISTS knowledge_ai;
    DROP TRIGGER IF EXISTS knowledge_au;
    DROP TRIGGER IF EXISTS knowledge_ad;
    DROP TABLE IF EXISTS sessions_fts;
    DROP TABLE IF EXISTS knowledge_fts;
  `);
} catch { /* ignore */ }

try {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
      summary,
      project,
      content='sessions',
      content_rowid='rowid'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
      content,
      project,
      filename,
      content='project_knowledge',
      content_rowid='rowid'
    );
  `);

  // Populate FTS with existing data
  db.exec(`
    DELETE FROM sessions_fts;
    INSERT INTO sessions_fts(rowid, summary, project) SELECT rowid, summary, project FROM sessions WHERE summary != '';

    DELETE FROM knowledge_fts;
    INSERT INTO knowledge_fts(rowid, content, project, filename) SELECT rowid, content, project, filename FROM project_knowledge WHERE content != '';
  `);

  // Triggers to keep FTS in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS sessions_ai AFTER INSERT ON sessions BEGIN
      INSERT INTO sessions_fts(rowid, summary, project) VALUES (new.rowid, new.summary, new.project);
    END;
    CREATE TRIGGER IF NOT EXISTS sessions_au AFTER UPDATE OF summary ON sessions BEGIN
      DELETE FROM sessions_fts WHERE rowid = old.rowid;
      INSERT INTO sessions_fts(rowid, summary, project) VALUES (new.rowid, new.summary, new.project);
    END;
    CREATE TRIGGER IF NOT EXISTS sessions_ad AFTER DELETE ON sessions BEGIN
      DELETE FROM sessions_fts WHERE rowid = old.rowid;
    END;

    CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON project_knowledge BEGIN
      INSERT INTO knowledge_fts(rowid, content, project, filename) VALUES (new.rowid, new.content, new.project, new.filename);
    END;
    CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE OF content ON project_knowledge BEGIN
      DELETE FROM knowledge_fts WHERE rowid = old.rowid;
      INSERT INTO knowledge_fts(rowid, content, project, filename) VALUES (new.rowid, new.content, new.project, new.filename);
    END;
    CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON project_knowledge BEGIN
      DELETE FROM knowledge_fts WHERE rowid = old.rowid;
    END;
  `);
} catch {
  // FTS5 not available or already exists — skip
}

// Session token usage table
db.exec(`
  CREATE TABLE IF NOT EXISTS session_usage (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    model TEXT NOT NULL DEFAULT '',
    recorded_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_usage_session ON session_usage(session_id);
  CREATE INDEX IF NOT EXISTS idx_usage_agent ON session_usage(agent_id);
`);

// Migration: track cache tokens in session_usage (needed for accurate USD cost).
try {
  db.prepare('SELECT cache_read_tokens FROM session_usage LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE session_usage ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0`);
  db.exec(`ALTER TABLE session_usage ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0`);
}

// Agent task queue. project_id links softly to the Goal Cascade (no FK
// enforcement — tolerate nulls / deleted projects).
db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL DEFAULT '',
    project_id TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    assigned_agent_id TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    result TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    claimed_at TEXT,
    completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(assigned_agent_id);
`);

// Transcript messages table — rich per-turn capture from the session JSONL.
// Unifies Claude Code and Gridlight sessions (engine column). Unique (session_id, seq)
// makes hook ingestion idempotent on retries/overlapping byte ranges.
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '[]',
    model TEXT NOT NULL DEFAULT '',
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    engine TEXT NOT NULL DEFAULT 'claude',
    ts TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);
  CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages(agent_id, ts);
`);

// ── Confer (standalone multi-agent collaboration) ───────────────────────────
// A Confer is a milestone-driven collaboration between 2+ live agents, run by its
// own conductor (lib/confer-conductor.ts): it dispatches each milestone to every
// participant, waits for all to signal done, then auto-advances to the next. Kept
// deliberately separate from the workflow engine — its own tables, its own loop.
db.exec(`
  CREATE TABLE IF NOT EXISTS confer_sessions (
    id TEXT PRIMARY KEY,
    repo_name TEXT NOT NULL DEFAULT '',
    repo_path TEXT NOT NULL DEFAULT '',
    task TEXT NOT NULL DEFAULT '',
    participant_ids TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'running',
    current_milestone INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    completed_at TEXT,
    build_rounds INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS confer_milestones (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    round INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'pending',
    done_ids TEXT NOT NULL DEFAULT '[]',
    results TEXT NOT NULL DEFAULT '{}',
    dispatched_at TEXT,
    completed_at TEXT,
    nudged INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_confer_ms_session ON confer_milestones(session_id, idx);
`);

// Migration: add attachments column to confer_sessions — same repoPath → prompt-block map
// as workflows, appended to every milestone prompt so both engines can open the files.
try {
  db.prepare('SELECT attachments FROM confer_sessions LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE confer_sessions ADD COLUMN attachments TEXT NOT NULL DEFAULT '{}'`);
}

// Migration: confer collaboration mode + worktree isolation.
//   mode:       'divide' (split into per-agent slices) | 'collaborate' (one shared solution)
//   isolation:  'shared' | 'worktree' (each agent gets its own git worktree+branch; divide only)
//   worktrees:  agentId → {path,branch} map provisioned at start (empty when shared)
try {
  db.prepare('SELECT mode FROM confer_sessions LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE confer_sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'divide'`);
  db.exec(`ALTER TABLE confer_sessions ADD COLUMN isolation TEXT NOT NULL DEFAULT 'shared'`);
  db.exec(`ALTER TABLE confer_sessions ADD COLUMN worktrees TEXT NOT NULL DEFAULT '{}'`);
}

// Migration: iterated build rounds. `build_rounds` = how many times the build/fix milestone
// runs (default 1 = the original single-build cycle), `round` = which of those a milestone row
// is. Probed and added SEPARATELY — a half-applied pair (one column added, then a crash) must
// still converge, which a single combined try/catch cannot do.
try {
  db.prepare('SELECT build_rounds FROM confer_sessions LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE confer_sessions ADD COLUMN build_rounds INTEGER NOT NULL DEFAULT 1`);
}
try {
  db.prepare('SELECT round FROM confer_milestones LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE confer_milestones ADD COLUMN round INTEGER NOT NULL DEFAULT 1`);
}

// Workflow Steps table (V2 canvas workflows)
db.exec(`
  CREATE TABLE IF NOT EXISTS workflow_steps (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    position_x REAL NOT NULL DEFAULT 0,
    position_y REAL NOT NULL DEFAULT 0,
    executor_type TEXT NOT NULL,
    executor_id TEXT NOT NULL DEFAULT '',
    executor_config TEXT NOT NULL DEFAULT '{}',
    auto_advance INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'pending',
    result TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    depends_on TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_workflow_steps_workflow ON workflow_steps(workflow_id);
  CREATE INDEX IF NOT EXISTS idx_workflow_steps_status ON workflow_steps(status);
`);

// Durable workflow journal — append-only run history used by the dashboard and
// by crash recovery. Unlike websocket step logs, these entries survive terminal
// crashes, server restarts, and UI reconnects.
db.exec(`
  CREATE TABLE IF NOT EXISTS workflow_journal (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    step_id TEXT NOT NULL DEFAULT '',
    step_name TEXT NOT NULL DEFAULT '',
    event_type TEXT NOT NULL DEFAULT 'info',
    message TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_workflow_journal_workflow ON workflow_journal(workflow_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_workflow_journal_step ON workflow_journal(step_id, created_at);
`);

// Migration: add plan_content column to workflow_steps (stores plan captured from ExitPlanMode)
try {
  db.prepare('SELECT plan_content FROM workflow_steps LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE workflow_steps ADD COLUMN plan_content TEXT NOT NULL DEFAULT ''`);
}

// Migration: add dispatched_prompt column to workflow_steps (stores the full prompt sent to the agent)
try {
  db.prepare('SELECT dispatched_prompt FROM workflow_steps LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE workflow_steps ADD COLUMN dispatched_prompt TEXT NOT NULL DEFAULT ''`);
}


// Capability-routing substitutions are recorded separately from `error`, which the UI
// paints red. A step that ran correctly on frontier because the router said so is not an
// error, and decorating it as one erodes trust in the feature we want left enabled.
try {
  db.prepare('SELECT routing_note FROM workflow_steps LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE workflow_steps ADD COLUMN routing_note TEXT NOT NULL DEFAULT ''`);
}

// engine_demotions predates failure_streak on any database created before the streak was
// persisted; CREATE TABLE IF NOT EXISTS will not add a column to an existing table.
try {
  db.prepare('SELECT failure_streak FROM engine_demotions LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE engine_demotions ADD COLUMN failure_streak INTEGER NOT NULL DEFAULT 0`);
}

// ── Queue: ordered, heterogeneous work that drains unattended ──────────────────────────
// Separate from `tasks` on purpose: a task is agent-CLAIMED work, this is ordered DISPATCH.
// Different grain and different lifetime, the same reason profiles and demotions are two
// tables. `lane` is the serial unit — a cartridge runs one thing at a time, so one long item
// must not block every other cartridge.
db.exec(`
  CREATE TABLE IF NOT EXISTS queue_items (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    targets_json TEXT NOT NULL DEFAULT '[]',
    lane TEXT NOT NULL DEFAULT 'default',
    status TEXT NOT NULL DEFAULT 'queued',
    position INTEGER NOT NULL DEFAULT 0,
    handle TEXT NOT NULL DEFAULT '',
    result TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    stall_ticks INTEGER NOT NULL DEFAULT 0
  );

  -- One row per (item, agent) so a report delivered twice counts ONCE. Without this a
  -- duplicate hook delivery or a reconnect replay advances two items on one completion.
  CREATE TABLE IF NOT EXISTS queue_completions (
    item_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    ok INTEGER NOT NULL DEFAULT 1,
    detail TEXT NOT NULL DEFAULT '',
    reported_at TEXT NOT NULL,
    PRIMARY KEY (item_id, agent_id)
  );

  -- Retry budgets, so a transient failure is distinguishable from a real one. A socket blip
  -- during startup, a relay reconnect and a deploy restart are ORDINARY; halting a lane on any
  -- of them means the queue converges on fully stopped over a week of unattended running.
  -- attempts    = consecutive dispatch failures
  -- stall_ticks = consecutive ticks a running item's target has been unreachable

  -- A lane can be paused without cancelling what is queued behind it.
  CREATE TABLE IF NOT EXISTS queue_lanes (
    lane TEXT PRIMARY KEY,
    paused INTEGER NOT NULL DEFAULT 0,
    halted_reason TEXT NOT NULL DEFAULT '',
    -- WHICH item halted this lane, recorded rather than inferred. Retry needs to resume only
    -- the halt its own item caused, and some halt reasons name the item while others do not
    -- ("dispatch failed 3x: ..."), so matching on the human-readable string is unreliable.
    halted_by TEXT NOT NULL DEFAULT ''
  );
`);

try { db.prepare('SELECT halted_by FROM queue_lanes LIMIT 1').get(); }
catch { db.exec(`ALTER TABLE queue_lanes ADD COLUMN halted_by TEXT NOT NULL DEFAULT ''`); }

for (const col of ['attempts', 'stall_ticks']) {
  try { db.prepare(`SELECT ${col} FROM queue_items LIMIT 1`).get(); }
  catch { db.exec(`ALTER TABLE queue_items ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`); }
}

// THE BINDING STAMP. A completion report proves an AGENT finished something; it does not say
// WHICH item. Without this, a late report from the previous item -- or the user's own manual
// work in the same cartridge -- advances the queue. Same defect shape as an unattributable
// trouble signal, one level up and with worse consequences.
try {
  db.prepare('SELECT active_queue_item_id FROM agents LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE agents ADD COLUMN active_queue_item_id TEXT NOT NULL DEFAULT ''`);
}

// Gridlight already SENDS its model at registration; the server was dropping it. Without
// this column nothing can say which model a cartridge runs, so the router can never find a
// profile and every decision is UNMEASURED -> frontier.
try {
  db.prepare('SELECT model FROM agents LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE agents ADD COLUMN model TEXT NOT NULL DEFAULT ''`);
}

// Migration: add token tracking columns to workflow_steps
try {
  db.prepare('SELECT tokens_in FROM workflow_steps LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE workflow_steps ADD COLUMN tokens_in INTEGER NOT NULL DEFAULT 0`);
  db.exec(`ALTER TABLE workflow_steps ADD COLUMN tokens_out INTEGER NOT NULL DEFAULT 0`);
}

// Migration: crash-recovery columns on workflow_steps.
// A step 'running' when its agent dies (SIGTERM / power loss) hangs forever —
// standard steps complete only via webhook. These columns let the reconciler
// flag such steps and drive transcript-replay recovery without adding a new
// value to the executor's status state machine (status stays 'running';
// recovery_status carries the recovery flow). See
// .neoncore/docs/recovery-subsystem-plan.md.
//   recovery_status: '' | 'interrupted' | 'recovering' | 'recovered' | 'recovery_failed'
try {
  db.prepare('SELECT recovery_status FROM workflow_steps LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE workflow_steps ADD COLUMN native_session_id TEXT NOT NULL DEFAULT ''`);
  db.exec(`ALTER TABLE workflow_steps ADD COLUMN interrupted_at TEXT`);
  db.exec(`ALTER TABLE workflow_steps ADD COLUMN recovery_status TEXT NOT NULL DEFAULT ''`);
  db.exec(`ALTER TABLE workflow_steps ADD COLUMN recovery_attempts INTEGER NOT NULL DEFAULT 0`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_workflow_steps_recovery ON workflow_steps(recovery_status)`);
}

// NB: the goals token_budget migration used to sit here, ABOVE the CREATE TABLE that
// makes `goals`. See the note where it now lives (after the schema block) — running it
// here made a fresh database impossible to create at all.

// Virtual Cartridges table — local folder workspaces.
db.exec(`
  CREATE TABLE IF NOT EXISTS virtual_cartridges (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    directory_path TEXT NOT NULL UNIQUE,
    icon_index INTEGER NOT NULL DEFAULT 0,
    color TEXT NOT NULL DEFAULT '#a855f7',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_virtual_cartridges_path ON virtual_cartridges(directory_path);
`);

// Federation peers — the other NeonCore servers this one gossips with.
//
// This is a grow-only set of URLs, NOT a replicated dataset. Union is the whole merge
// algorithm; removal is a staleness rule, not consensus. Deliberately no tombstones and
// no conflict resolution — a peer list of URLs does not warrant either.
//
// `url` is the primary key and is stored NORMALIZED (see normalizePeerUrl in
// lib/federation.ts). Without that, `host:4040` and `host:4040/` are two rows and the
// same server gets pinged, counted, and merged twice.
//
// The peer list carries NO SECRETS — only URLs. The one fleet token authenticates every
// direction, so there is nothing per-peer to store.
db.exec(`
  CREATE TABLE IF NOT EXISTS peers (
    url TEXT PRIMARY KEY,
    server_id TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    version TEXT NOT NULL DEFAULT '',
    last_ok_at TEXT NOT NULL DEFAULT '',
    last_error TEXT NOT NULL DEFAULT '',
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    added_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_peers_last_ok ON peers(last_ok_at);
`);

// Cleanup: expire stale pending permissions from past sessions
const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
const expired = db.prepare(
  `UPDATE permissions SET status = 'expired', decided_at = ? WHERE status = 'pending' AND created_at < ?`
).run(new Date().toISOString(), fiveMinAgo);
if (expired.changes > 0) {
  console.log(`[db] Expired ${expired.changes} stale pending permission(s) from past sessions`);
}

// Session journal table — tracks session lifecycle per agent
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    project TEXT NOT NULL DEFAULT '',
    repo_path TEXT NOT NULL DEFAULT '',
    machine TEXT NOT NULL DEFAULT '',
    branch TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL,
    ended_at TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    activity_count INTEGER NOT NULL DEFAULT 0,
    summary TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
`);

// Project knowledge files — per-project editable markdown documents
db.exec(`
  CREATE TABLE IF NOT EXISTS project_knowledge (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    filename TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    UNIQUE(project, filename)
  );

  CREATE INDEX IF NOT EXISTS idx_knowledge_project ON project_knowledge(project);

  -- Centralized command templates
  CREATE TABLE IF NOT EXISTS command_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'Custom',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_command_templates_category ON command_templates(category);

  -- Cleanup performance indexes
  CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON activity(timestamp);
  CREATE INDEX IF NOT EXISTS idx_commands_created ON commands(created_at);

  -- Add project column to notes for project-scoped notes
  -- (SQLite ALTER TABLE ADD COLUMN is safe to run multiple times if column exists — handled below)

  -- Project learnings — extracted insights from workflow runs, scoped to a goal project
  CREATE TABLE IF NOT EXISTS project_learnings (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    workflow_id TEXT NOT NULL,
    workflow_name TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_project_learnings_project ON project_learnings(project_id);
  CREATE INDEX IF NOT EXISTS idx_project_learnings_workflow ON project_learnings(workflow_id);

  -- Goals: top-level business objectives
  CREATE TABLE IF NOT EXISTS goals (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    success_metric TEXT NOT NULL DEFAULT '',
    budget_usd REAL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);

  -- Projects: work areas that serve a goal
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    primary_repo TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '#a855f7',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_projects_goal ON projects(goal_id);

  -- Heartbeats: scheduled recurring workflow runs per project
  CREATE TABLE IF NOT EXISTS heartbeats (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    template_id TEXT NOT NULL,
    agent_id TEXT NOT NULL DEFAULT '',
    schedule TEXT NOT NULL DEFAULT '{"type":"daily","time":"09:00"}',
    label TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    last_run_at TEXT,
    next_run_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_heartbeats_project ON heartbeats(project_id);
  CREATE INDEX IF NOT EXISTS idx_heartbeats_due ON heartbeats(active, next_run_at);

  -- Expo push tokens for the mobile app. One row per device; the token is the identity,
  -- so re-registering the same device is an idempotent upsert. Invalid tokens are pruned
  -- when Expo reports DeviceNotRegistered (see lib/push.ts).
  CREATE TABLE IF NOT EXISTS push_tokens (
    token TEXT PRIMARY KEY,
    platform TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  );

  -- Registered machines running the runner daemon. Each holds a socket so the server can
  -- dispatch a "launch this cartridge here" instruction remotely (from web/mobile). The repos
  -- column is the runner's allowlist of launchable directories — the only paths it starts in.
  CREATE TABLE IF NOT EXISTS machines (
    id TEXT PRIMARY KEY,
    hostname TEXT NOT NULL DEFAULT '',
    platform TEXT NOT NULL DEFAULT '',
    arch TEXT NOT NULL DEFAULT '',
    repos TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'offline',
    last_seen TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

// ── Projects own CARTRIDGES ────────────────────────────────────────────────────────────
// A project used to be linked to work by hanging project_id on each TASK, which meant only
// work someone filed as a task counted — a prompt, confer or workflow run in the same repo was
// invisible to the project it obviously belonged to. A cartridge IS a repo checkout, so
// project -> repo is the durable link and everything happening in that repo is attributable
// with nobody tagging anything.
//
// `primary_repo` was already this link, singular. This makes it a set so a project spanning a
// server and a dashboard no longer has to pick one.
db.exec(`
  CREATE TABLE IF NOT EXISTS project_cartridges (
    project_id TEXT NOT NULL,
    repo_path TEXT NOT NULL,
    PRIMARY KEY (project_id, repo_path)
  );
`);

// BACKFILL, and it must be idempotent: every existing project keeps its repo as a cartridge.
// Without this an upgrade silently unlinks live projects, and the only symptom is a project
// that suddenly looks idle — nothing errors, so nobody notices.
db.exec(`
  INSERT OR IGNORE INTO project_cartridges (project_id, repo_path)
  SELECT id, primary_repo FROM projects WHERE COALESCE(primary_repo, '') != '';
`);


// Migration: add token_budget to goals (replaces budget_usd).
//
// This MUST stay below the CREATE TABLE for `goals`. It previously ran ~120 lines higher,
// before the table existed, which made a brand-new database impossible to initialize:
// the probing SELECT threw "no such table: goals", the catch then ran ALTER TABLE against
// the same missing table, and *that* throw was uncaught — so db.ts crashed at import and
// took the whole server down on boot.
//
// It went unnoticed because every existing install already had the table from an older
// build; only a first-ever launch hits it. Federation is exactly that case — every new
// machine in the fleet starts from an empty database.
//
// The probe-then-ALTER shape is still right; the ordering was the bug. Adding the column
// to CREATE TABLE instead would silently skip it for everyone who already has the table.
try {
  db.prepare('SELECT token_budget FROM goals LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE goals ADD COLUMN token_budget INTEGER`);
}

// Add project column to notes table (migration-safe)
try {
  db.prepare("SELECT project FROM notes LIMIT 1").get();
} catch {
  db.prepare("ALTER TABLE notes ADD COLUMN project TEXT NOT NULL DEFAULT ''").run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_notes_project ON notes(project)").run();
}

// Backfill project on existing notes from their agent's repo_name
const orphanNotes = db.prepare("SELECT n.id, a.repo_name FROM notes n JOIN agents a ON n.agent_id = a.id WHERE n.project = '' AND a.repo_name != ''").all() as { id: string; repo_name: string }[];
if (orphanNotes.length > 0) {
  const update = db.prepare("UPDATE notes SET project = ? WHERE id = ?");
  for (const n of orphanNotes) {
    update.run(n.repo_name, n.id);
  }
  console.log(`[db] Migrated ${orphanNotes.length} notes to project-scoped`);
}

// ── Seed default workflow templates ──────────────────────────────────────────
// Creates 5 starter templates if none exist yet. Safe to run on every boot —
// skips seeding if any pending templates are already present.

function seedDefaultTemplates() {
  // Always replace the 5 standard templates by name so schema changes take effect.
  // User-created templates with other names are left untouched.
  const standardNames = ['Bug Hunter', 'New Feature', 'CI/CD Pipeline', 'Feature Validation', 'Deep Research', 'Jira Tasks Validation', 'Jira Tasks Completion', 'Product Strategy Session', 'Engineering Architecture Review', 'Full QA Review', 'Bug Investigation', 'Code Review & Audit', 'CE: Phase 1 — Interrogate', 'CE: Phase 2 — Plan', 'CE: Phase 3 — Implement', 'CE: Phase 4 — Review', 'CE: Phase 5 — QA', 'CE: Phase 6 — Ship', 'CE: Phase 7 — Compound', 'CE: Full Delivery'];
  for (const name of standardNames) {
    const rows = db.prepare("SELECT id FROM workflows WHERE name = ? AND template_id IS NULL").all(name) as { id: string }[];
    for (const row of rows) {
      db.prepare("DELETE FROM workflow_steps WHERE workflow_id = ?").run(row.id);
      db.prepare("DELETE FROM workflows WHERE id = ?").run(row.id);
    }
  }

  // Remove deprecated templates on every boot so they don't linger in existing DBs
  const deprecatedNames = ['Feature Fix', 'Code Improvement', 'Refactor'];
  for (const name of deprecatedNames) {
    const rows = db.prepare("SELECT id FROM workflows WHERE name = ? AND template_id IS NULL").all(name) as { id: string }[];
    for (const row of rows) {
      db.prepare("DELETE FROM workflow_steps WHERE workflow_id = ?").run(row.id);
      db.prepare("DELETE FROM workflows WHERE id = ?").run(row.id);
    }
  }

  const now = new Date().toISOString();

  const insertWorkflow = db.prepare(`
    INSERT INTO workflows (id, name, description, status, target_repos, created_at, started_at)
    VALUES (?, ?, ?, 'pending', '[]', ?, '')
  `);

  const insertStep = db.prepare(`
    INSERT INTO workflow_steps
      (id, workflow_id, name, description, position_x, position_y,
       executor_type, executor_id, executor_config, auto_advance, depends_on, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Agent-based types need __deferred__ so the user picks a cartridge at run time.
  // Connector/command steps run without a cartridge.
  const DEFERRED_TYPES = new Set(['claude-code', 'quality-gate', 'review-gate', 'deliberation']);

  function step(
    wfId: string,
    id: string,
    name: string,
    desc: string,
    x: number,
    y: number,
    type: string,
    config: Record<string, unknown>,
    deps: string[],
    auto = true,
  ) {
    const executorId = DEFERRED_TYPES.has(type) ? '__deferred__' : '';
    insertStep.run(id, wfId, name, desc, x, y, type, executorId, JSON.stringify(config), auto ? 1 : 0, JSON.stringify(deps), now);
  }

  const cc = (role: string, extra: Record<string, unknown> = {}) => ({
    role,
    includeDepOutput: true,
    systemPromptMode: 'free',
    systemPrompt: '',
    loopCount: 1,
    ...extra,
  });

  const gate = (gateType: string) => ({ gateType, includeDepOutput: true });

  // Layout constants: all steps x=300, y increments by 175 (fully linear/sequential).

  // ── 1. Bug Hunter ────────────────────────────────────────────────────────
  {
    const wfId = randomUUID();
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(), s5 = randomUUID(), s6 = randomUUID(), s7 = randomUUID();
    insertWorkflow.run(wfId, 'Bug Hunter',
      'Proactive bug hunt: static analysis → dead code → bug pattern scan → prioritize & plan → implement fixes → verify → notify.', now);

    step(wfId, s1, 'Static & Lint Analysis',
      'Run the compiler and linter to surface all type errors, lint violations, and build warnings. No code changes.',
      300, 80, 'claude-code',
      {
        ...cc('reviewer'),
        prompt: 'Run a full static analysis pass on this codebase. Do NOT make any code changes — only identify and document issues.\n\n1. DETECT LANGUAGE & TOOLS — Check what\'s available: TypeScript (`tsc --noEmit`), ESLint (`npx eslint . --format compact`), Rust (`cargo check`, `cargo clippy`), Python (`ruff check .` or `flake8`), etc. Run whatever applies to this project.\n\n2. RUN EACH TOOL and capture all output.\n\n3. OUTPUT all findings grouped by file in this format:\n```\n## Static Analysis Findings\n\n### [file:line]\nSEVERITY: error | warning | info\nISSUE: [description]\n```\n\nEnd with a count: `Total findings: N (errors: X, warnings: Y)`\n\nIf no issues found, say "STATIC: CLEAN".',
      }, []);

    step(wfId, s2, 'Dead Code Scan',
      'Find all unused code: imports, variables, functions, exports, unreachable branches, empty catch blocks, and commented-out code.',
      300, 310, 'claude-code',
      {
        ...cc('reviewer'),
        prompt: 'Scan the entire codebase for dead code. Do NOT make any changes — only identify and document. Use Read, Grep, and Glob tools extensively.\n\nLook for all of the following:\n\n**Unused imports** — imported but never referenced in the file.\n**Unused variables** — declared but never read after assignment.\n**Unused functions/methods** — defined but never called anywhere in the project.\n**Unreachable code** — code after a `return`, `throw`, or `break`; branches that can never be true.\n**Empty or swallowed catch blocks** — `catch (e) {}` or `catch { /* ignore */ }` with no logging or handling.\n**Dead exports** — symbols exported but never imported by any other file.\n**Commented-out code blocks** — large sections of code left as comments (not doc comments).\n**Redundant conditions** — `if (true)`, `if (false)`, always-truthy/falsy guards.\n\nFor each finding:\n```\n### [file:line]\nTYPE: unused-import | unused-var | unused-function | unreachable | empty-catch | dead-export | commented-code | redundant-condition\nDETAIL: [what it is and why it\'s dead]\n```\n\nEnd with: `Dead code findings: N`',
      }, [s1]);

    step(wfId, s3, 'Bug Pattern Hunt',
      'Systematically scan for common bug patterns: null access, missing awaits, race conditions, silent failures, incorrect comparisons, and missing error handling.',
      300, 540, 'claude-code',
      {
        ...cc('reviewer'),
        prompt: 'Scan the codebase for common bug patterns. Do NOT make any changes — only document findings. Use Read, Grep, and Glob tools.\n\nCheck for each of these patterns:\n\n**Null/undefined access without guards** — `obj.property` or `arr[i]` where the value could be null/undefined/out-of-bounds.\n**Missing await** — async functions called without `await`; promises returned but never resolved or caught.\n**Unhandled promise rejections** — `.then()` chains without `.catch()`; `async` functions whose returned promise is not awaited or caught by the caller.\n**Race conditions** — shared state mutated across async boundaries; multiple concurrent writes without locking.\n**Off-by-one errors** — loop bounds, array slices, index comparisons using `<` vs `<=`.\n**Incorrect equality** — `==` instead of `===` in JS/TS; comparison of different types.\n**Silent failures** — operations that can fail but have no error path (missing `try/catch`, ignoring return codes, swallowing errors).\n**Missing input validation** — user-facing functions or API handlers that don\'t validate/sanitize their inputs.\n**Incorrect state updates** — mutating state directly instead of via setState/reducers; stale closures capturing outdated values.\n**Memory leaks** — event listeners added but never removed; timers/intervals not cleared; large objects held in long-lived scope.\n**Hardcoded values** — URLs, credentials, magic numbers that should be config or constants.\n\nFor each finding:\n```\n### [file:line]\nPATTERN: [pattern name from list above]\nSEVERITY: critical | high | medium | low\nDETAIL: [what the bug is and what could go wrong at runtime]\n```\n\nEnd with: `Bug patterns found: N (critical: X, high: Y, medium: Z, low: W)`',
      }, [s2]);

    step(wfId, s4, 'Prioritize & Plan Fixes',
      'Collate all findings from the three scans, rank by severity, and write a concrete fix plan. Manual advance — review before any code changes.',
      300, 770, 'claude-code',
      {
        ...cc('planner'),
        prompt: 'Using the findings from the three previous steps (Static Analysis, Dead Code Scan, Bug Pattern Hunt), compile a prioritized fix plan.\n\n1. COLLATE ALL FINDINGS — List every unique issue found across all three steps. Deduplicate overlaps.\n\n2. RANK BY PRIORITY:\n   - **P0 — Critical**: crashes, data corruption, security holes, broken core paths\n   - **P1 — High**: wrong behavior under normal conditions, data loss risk, unhandled errors in prod paths\n   - **P2 — Medium**: edge case failures, incorrect logic that usually works, bad UX paths\n   - **P3 — Low**: style, minor inefficiency, non-critical dead code\n\n3. OUTPUT THE PLAN in this format:\n\n```\n## Bug Fix Plan\n\n### P0 — Critical ([count])\n| File:Line | Issue | Fix |\n|-----------|-------|-----|\n| [path:line] | [what the bug is] | [exact change to make] |\n\n### P1 — High ([count])\n[same table]\n\n### P2 — Medium ([count])\n[same table]\n\n### P3 — Low / Dead Code ([count])\n[same table]\n\n## Summary\nTotal issues: N | Estimated risk of fixing: low/medium/high\n```\n\nBe specific about the exact change for each fix — the next step will implement directly from this plan.',
      }, [s3], false);

    step(wfId, s5, 'Implement Fixes',
      'Apply all fixes from the plan in priority order (P0 → P1 → P2 → P3). Remove dead code. Document each change.',
      300, 1000, 'claude-code',
      {
        ...cc('backend'),
        prompt: 'Using the prioritized fix plan from the previous step, implement all fixes.\n\nWork through them in order: P0 first, then P1, P2, and finally P3 (dead code removal).\n\nFor each fix:\n1. Apply the minimal correct change — do not refactor beyond what is needed to fix the issue.\n2. For dead code (unused imports, variables, functions, unreachable branches): remove them entirely.\n3. For empty catch blocks: add at minimum a `console.error` or appropriate error logging.\n4. Log each change in this format:\n```\nFIXED [file:line] — [brief description of what was changed and why]\n```\n\nAfter all fixes are applied, output:\n```\n## Fixes Applied\n[list of all FIXED log lines]\n\nTotal fixed: N\nDead code removed: N items\n```\n\nDo not add new features. Do not refactor code beyond the fix. Do not change tests.',
      }, [s4]);

    step(wfId, s6, 'Verify',
      'Run the full test suite to confirm all fixes are correct and nothing was broken.',
      300, 1230, 'quality-gate',
      { ...gate('test'), routingRules: [{ id: randomUUID(), condition: 'contains', value: 'STATUS: FAIL', nextStepId: s5 }], maxCycles: 2 }, [s5]);

    step(wfId, s7, 'Notify',
      'System notification: Bug Hunter workflow complete.',
      300, 1460, 'connector',
      { connectorType: 'system-notify', title: 'Bug Hunter — Done', message: '{{workflowName}} finished. Check NeonCore for the full bug report.' }, [s6]);
  }

  // ── 3. New Feature ────────────────────────────────────────────────────────
  {
    const wfId = randomUUID();
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(), s5 = randomUUID(), s6 = randomUUID(), s7 = randomUUID(), s8 = randomUUID();
    insertWorkflow.run(wfId, 'New Feature',
      'Research → architect → define tests → develop → run tests → security → summary → notify.', now);
    step(wfId, s1, 'Research',        'Investigate existing approaches, patterns, and trade-offs.',                                                                                                                           300,   50, 'claude-code', cc('researcher'), []);
    step(wfId, s2, 'Architecture',    'Design implementation plan with file paths and interfaces. Manual advance — review before tests are written.',                                                                         300,  225, 'claude-code', cc('architect'),  [s1], false);
    step(wfId, s3, 'Define Tests',    'Define all test cases and acceptance criteria. For each test: describe the scenario, inputs, expected output, and what failure means. Do not write any implementation code.',          300,  400, 'claude-code', cc('tester'),     [s2]);
    step(wfId, s4, 'Develop',         'Build the feature following the architecture plan.',                                                                                                                                   300,  575, 'claude-code', cc('backend'),    [s3]);
    step(wfId, s5, 'Run Tests',       'Execute the tests defined in Define Tests. All acceptance criteria must pass.',                                                                                                        300,  750, 'quality-gate',
      { ...gate('test'), routingRules: [{ id: randomUUID(), condition: 'contains', value: 'STATUS: FAIL', nextStepId: s4 }], maxCycles: 3 }, [s4]);
    step(wfId, s6, 'Security & Lint', 'Full lint + security check.',                                                                                                                                                          300,  925, 'quality-gate', gate('security'), [s5]);
    step(wfId, s7, 'Summary',         'Document all changes, test results, and manual testing instructions.',                                                                                                                 300, 1100, 'claude-code', cc('planner'), [s6]);
    step(wfId, s8, 'Notify',          'System notification: New Feature workflow complete.',                                                                                                                             300, 1275, 'connector',
      { connectorType: 'system-notify', title: 'New Feature — Done', message: '{{workflowName}} finished. Check NeonCore for results.' }, [s7]);
  }

  // ── 5. CI/CD Pipeline ─────────────────────────────────────────────────────
  {
    const wfId = randomUUID();
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(), s5 = randomUUID();
    insertWorkflow.run(wfId, 'CI/CD Pipeline',
      'Code review → unit tests → integration tests → security → notify.', now);
    step(wfId, s1, 'Code Review',           'Review code quality, patterns, and edge cases.',                                                                                                                                 300,  50, 'quality-gate', gate('full-review'), []);
    step(wfId, s2, 'Run Unit Tests',        'Execute full unit test suite.',                                                                                                                                                  300, 225, 'quality-gate',
      { ...gate('test'), routingRules: [{ id: randomUUID(), condition: 'contains', value: 'STATUS: FAIL', nextStepId: s1 }], maxCycles: 1 }, [s1]);
    step(wfId, s3, 'Run Integration Tests', 'Execute integration and end-to-end tests.',                                                                                                                                      300, 400, 'claude-code',
      cc('tester', { systemPrompt: 'Run all integration and e2e tests. Report STATUS: PASS or STATUS: FAIL in your result.' }), [s2]);
    step(wfId, s4, 'Security Scan',         'Audit for OWASP issues, auth flaws, and credential exposure.',                                                                                                                   300, 575, 'quality-gate', gate('security'), [s3]);
    step(wfId, s5, 'Notify',                'System notification: CI/CD Pipeline workflow complete.',                                                                                                                  300, 750, 'connector',
      { connectorType: 'system-notify', title: 'CI/CD Pipeline — Done', message: '{{workflowName}} finished. Check NeonCore for results.' }, [s4]);
  }

  // ── 6. Feature Validation ─────────────────────────────────────────────────
  {
    const wfId = randomUUID();
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(), s5 = randomUUID(), s6 = randomUUID(), s7 = randomUUID();
    insertWorkflow.run(wfId, 'Feature Validation',
      'TDD-based feature validation: specify → define/review tests (human gate) → evaluate code → implement gaps → run tests → final report. Enter the feature description (and optional Jira epic key) in the launch prompt.', now);

    // Step 1: Feature Specification — spec is entered at launch time; step enriches it with Jira data if provided
    step(wfId, s1, 'Feature Specification',
      'Reads the specification entered at launch. If a Jira epic key was included, fetches the epic and all its tasks and merges requirements into the spec. Outputs a structured Feature Spec document passed to every subsequent step.',
      300, 80, 'claude-code',
      {
        ...cc('researcher'), workflowContext: true,
        prompt: 'The feature specification has been provided at launch (shown above). Your job is to structure it clearly and, if a Jira epic key was included, enrich it with the full epic task details.\n\n**STEP 1 — PARSE THE PROVIDED SPEC**\nRead the specification above carefully. Extract:\n- Feature name and functional description\n- Architectural expectations (layers, components, routes, DB tables, APIs)\n- Acceptance criteria\n- Edge cases and error states\n\n**STEP 2 — FETCH JIRA EPIC (if a key was provided)**\nIf the spec contains a Jira epic key (e.g. GRD-500):\n1. Discover the Jira CLI (`jira --version`, `jira-cli --version`, or project scripts).\n2. Fetch the epic and ALL its child tasks (stories, bugs, tasks, subtasks — recurse fully).\n3. For each task: collect title, status, description, and acceptance criteria.\n\n**STEP 3 — OUTPUT THE STRUCTURED FEATURE SPEC**\n\n```\n## Feature Specification\n\n### Feature Overview\n[What the feature does from a user perspective]\n\n### Architecture\n[Which layers, services, files, DB tables, API routes, and UI components are involved]\n\n### Functional Requirements\n[Numbered list of every requirement — each must be testable]\n\n### Acceptance Criteria\n- [ ] [every condition that must be true for the feature to be complete]\n\n### Edge Cases & Error States\n[Every edge case and expected handling]\n\n### Jira Epic Tasks (if applicable)\n| Key | Title | Status | Requirements |\n|-----|-------|--------|---------------|\n[one row per task]\n```\n\nOutput this document in full — it is the source of truth for all subsequent steps.',
      }, []);

    // Step 2: Test Discovery & Creation — find existing tests, write missing ones, STOP for human review
    step(wfId, s2, 'Test Discovery & Creation',
      'Find all existing tests related to this feature, identify gaps against the spec, write new tests for uncovered behaviors. STOPS for human review — you must confirm the tests truly validate the feature before the workflow continues.',
      300, 310, 'claude-code',
      {
        ...cc('tester'),
        prompt: 'Using the Feature Specification from the previous step, you must (1) find all existing tests related to this feature, (2) identify coverage gaps, and (3) write new tests for anything not already covered.\n\n**RULE: This step must NOT auto-advance. You will output a test manifest and wait for human approval.**\n\n### PHASE 1 — DISCOVER EXISTING TESTS\n1. Use Grep, Glob, and Read to search the entire test suite for tests related to this feature.\n   - Search by feature name, component names, route paths, function names, DB table names, and key terms from the Feature Specification.\n   - Look in all test directories: `*.test.ts`, `*.spec.ts`, `*.test.tsx`, `__tests__/`, `test/`, `spec/` and any other test file patterns in this project.\n2. For each relevant test found, record:\n   - File path and test name/describe block\n   - What behavior it validates\n   - Whether it maps to a requirement in the Feature Spec\n\n### PHASE 2 — IDENTIFY GAPS\nCross-reference every requirement and acceptance criterion from the Feature Spec against the existing tests.\nFor each requirement, answer: Is it covered? If YES — by which test(s)? If NO — what test is needed?\n\n### PHASE 3 — WRITE MISSING TESTS\nFor every gap identified:\n1. Write real, runnable tests that assert the behavior described in the spec.\n2. Each new test must cover: happy path + at least 2 edge cases + at least 1 error state per requirement.\n3. Tests must be written so they FAIL before the implementation is correct — do not write tests that trivially pass.\n4. Follow the existing test patterns, frameworks, and conventions used in this project (detect from existing test files).\n5. Save new tests to the appropriate test file(s) — either extending an existing file or creating a new one following the project conventions.\n\n### PHASE 4 — OUTPUT THE TEST MANIFEST\nOutput the complete manifest in this exact format — do NOT advance automatically:\n\n```\n## Test Manifest for: [Feature Name]\n\n### Existing Tests (covers this feature)\n| File | Test Name | Requirement Covered |\n|------|-----------|--------------------|\n[one row per relevant test]\n\n### New Tests Written\n| File | Test Name | Requirement Covered | Status |\n|------|-----------|---------------------|--------|\n[one row per new test, Status = NEW]\n\n### Coverage Summary\n- Requirements from spec: N\n- Fully covered by existing tests: N\n- Covered by new tests: N\n- Remaining gaps (if any): N — [list them]\n\n### Instructions for Human Review\nPlease review the test manifest above and confirm:\n1. Do the existing tests truly validate the listed requirements?\n2. Do the new tests cover the gaps accurately?\n3. Are there any additional scenarios you want tested?\n\nOnce you are satisfied, advance this step manually to continue the workflow.\n```',
      }, [s1], false);

    // Step 3: Code Evaluation — deep analysis of current implementation vs spec
    step(wfId, s3, 'Code Evaluation',
      'Thoroughly evaluate the current codebase against the Feature Specification. Identify every gap, incorrect behavior, and missing implementation.',
      300, 540, 'claude-code',
      {
        ...cc('reviewer'),
        prompt: 'Using the Feature Specification (step 1) and the Test Manifest (step 2), perform a deep, thorough evaluation of the current codebase to determine how well the feature is implemented.\n\n**Do NOT make any code changes in this step — only investigate and report.**\n\n### PHASE 1 — MAP THE IMPLEMENTATION\nTrace every file, function, route, component, hook, and DB query involved in this feature using Read, Grep, and Glob.\nFollow the data flow end-to-end: from the user trigger → through every layer → to the final output/state change.\n\n### PHASE 2 — EVALUATE EACH REQUIREMENT\nFor every requirement and acceptance criterion in the Feature Spec, answer:\n- Is it implemented? (YES / PARTIAL / NO)\n- If YES: which code handles it and does it match the spec exactly?\n- If PARTIAL: what part is missing or wrong?\n- If NO: what needs to be built?\n\n### PHASE 3 — IDENTIFY BUGS & GAPS\nAlso check for:\n- Logic errors that would cause wrong behavior\n- Missing error handling on async calls, DB queries, or API responses\n- Race conditions or state inconsistencies\n- Missing input validation\n- Edge cases from the spec that are not handled\n- Architectural mismatches (wrong layer, wrong data flow)\n\n### PHASE 4 — OUTPUT THE EVALUATION REPORT\n```\n## Code Evaluation Report\n\n### Implementation Status per Requirement\n| Requirement | Status | Files | Notes |\n|-------------|--------|-------|-------|\n[one row per requirement from the Feature Spec — Status: ✅ Implemented / ⚠️ Partial / ❌ Missing]\n\n### Gaps & Issues Found\n| Severity | File:Line | Description | Fix Needed |\n|----------|-----------|-------------|------------|\n[one row per gap or bug — Severity: critical / high / medium / low]\n\n### Summary\n- Fully implemented: N/N requirements\n- Partially implemented: N requirements\n- Not implemented: N requirements\n- Bugs/issues found: N (critical: X, high: Y, medium: Z, low: W)\n\n### Verdict\n[STATUS: COMPLETE — all requirements fully implemented with no issues]\n[STATUS: INCOMPLETE — list the top items that must be fixed]\n```',
      }, [s2]);

    // Step 4: Code Implementation — fix gaps, never touch tests
    step(wfId, s4, 'Code Implementation',
      'Implement all missing or incorrect code identified in the Code Evaluation. Fix every gap in priority order. Do NOT modify any test files.',
      300, 770, 'claude-code',
      {
        ...cc('backend'),
        prompt: 'Using the Code Evaluation Report from the previous step, implement all fixes and additions needed to make the feature fully comply with the Feature Specification.\n\n**CRITICAL RULE: You must NEVER modify, delete, or weaken any test file. If a test exposes a bug in the implementation, fix the implementation — not the test.**\n\n### IMPLEMENTATION ORDER\nWork through issues in this priority order:\n1. **Critical** — crashes, data corruption, completely missing core paths\n2. **High** — wrong behavior on the happy path, missing required logic\n3. **Medium** — edge cases not handled, partial implementations\n4. **Low** — minor issues, missing error state handling\n\nFor each gap from the evaluation report:\n1. Read the relevant files to understand the existing patterns and conventions.\n2. Implement the minimal correct change — do not refactor beyond what is needed.\n3. Follow the architecture described in the Feature Specification.\n4. Handle all error states and edge cases specified.\n5. Log each change: `IMPLEMENTED [file:line] — [brief description of what was changed and why]`\n\n### AFTER ALL CHANGES\nOutput:\n```\n## Implementation Summary\n\n### Changes Made\n[List of all IMPLEMENTED log lines]\n\n### Gaps Resolved\n[Map each fix to the requirement it addresses]\n\n### Remaining Issues (if any)\n[Anything that could not be implemented and why]\n\nTotal files changed: N | Requirements now fully implemented: N/N\n```',
      }, [s3]);

    // Step 5: Run Tests — quality-gate loops back to implementation if tests fail
    step(wfId, s5, 'Run Tests',
      'Execute all tests from the Test Manifest. If any fail, the code is fixed — tests are never changed. Loops back to Code Implementation on failure (max 3 cycles).',
      300, 1000, 'quality-gate',
      {
        ...gate('test'),
        routingRules: [{ id: randomUUID(), condition: 'contains', value: 'STATUS: FAIL', nextStepId: s4 }],
        maxCycles: 3,
        includeDepOutput: true,
      }, [s4]);

    // Step 6: Final Report — full summary, requires human review before closing
    step(wfId, s6, 'Final Report',
      'Compile the complete validation report: what was specified, what tests were written, what code was changed, and the final test results. Requires human review.',
      300, 1175, 'claude-code',
      {
        ...cc('planner'),
        prompt: 'Compile the final Feature Validation report using all outputs from every previous step. Be thorough and precise.\n\n```\n## Feature Validation Report\n\n### Feature\n[Feature name and 1-sentence description]\n\n### Specification Summary\n[Bullet list of the key requirements from the Feature Spec]\n\n### Tests\n#### Existing Tests (pre-existing, related to this feature)\n| File | Test | Requirement |\n|------|------|-------------|\n\n#### New Tests Written\n| File | Test | Requirement |\n|------|------|-------------|\n\n### Code Changes\n#### What was already implemented correctly\n[Bullet list]\n\n#### What was fixed or added\n| File | Change | Requirement |\n|------|--------|-------------|\n\n### Test Results\n| Test | Result | Detail |\n|------|--------|--------|\n[one row per test from the run — PASS or FAIL]\n\n### Requirements Coverage\n| Requirement | Tests | Code | Status |\n|-------------|-------|------|--------|\n[one row per requirement from the Feature Spec]\n\n### Summary\n- Requirements: N total | N fully validated | N with gaps\n- Tests: N existing + N new = N total | N passed | N failed\n- Code changes: N files modified\n\n### Overall Verdict\n**STATUS: PASS** — all requirements implemented and all tests passing\n**STATUS: FAIL** — list the specific requirements or tests that are still not satisfied\n\n### Next Steps (if STATUS: FAIL)\n[Numbered list of remaining action items, highest severity first]\n```',
      }, [s5], false);

    // Step 7: Notify
    step(wfId, s7, 'Notify',
      'System notification: Feature Validation workflow complete.',
      300, 1350, 'connector',
      { connectorType: 'system-notify', title: 'Feature Validation — Done', message: '{{workflowName}} finished. Check NeonCore for the full validation report.' }, [s6]);
  }

  // ── 7. Deep Research ──────────────────────────────────────────────────────
  {
    const wfId = randomUUID();
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(), s5 = randomUUID(), s6 = randomUUID(), s7 = randomUUID();
    insertWorkflow.run(wfId, 'Deep Research',
      'Set the workflow description to the research subject — it is automatically injected into the first step. Web + local research → synthesis → your review → epic planning → save epic → optional Jira creation → notify.', now);

    // Step 1: Deep Research — search web + local dirs
    step(wfId, s1, 'Deep Research', 'Search the web and local codebase for papers, articles, and ideas on the subject.',
      300, 80, 'claude-code',
      {
        ...cc('researcher'), workflowContext: true,
        prompt: 'You are conducting deep research on the subject described above.\n\nDo both of the following:\n\n1. WEB RESEARCH — Use the WebSearch and WebFetch tools to find: academic papers, technical articles, blog posts, GitHub repos, documentation, and any other relevant online resources. Go at least 3 levels deep on the most promising leads. For each source: note the title, URL, key insights, and how it relates to the subject.\n\n2. LOCAL RESEARCH — Search the local project files for any existing work, prior art, related features, or relevant patterns using Read, Glob, and Grep tools.\n\nOutput all findings in a structured document:\n## Web Findings\n[Source-by-source: title, URL, key insight]\n\n## Local Findings\n[File paths and relevant code/content]\n\n## Key Ideas & Themes\n[Synthesized list of the most important concepts discovered]',
      }, []);

    // Step 2: Idea Synthesis — compile into a clean research brief
    step(wfId, s2, 'Idea Synthesis', 'Compile all research findings into a structured brief organized by theme, opportunity, and approach.',
      300, 310, 'claude-code',
      {
        ...cc('planner'),
        prompt: 'Using the research findings above, compile a clean, structured research brief:\n\n## Research Brief: [Subject]\n\n### Executive Summary\n[2-3 sentences on what the research found and why it matters]\n\n### Key Themes\n[Bullet list of the major themes that emerged]\n\n### Top Ideas & Opportunities\n[Numbered list of the most promising ideas, each with: what it is, why it matters, how it could apply]\n\n### Technical Approaches\n[Concrete implementation approaches found in research]\n\n### Open Questions\n[Things that need further investigation or user decisions]\n\n### Recommended Direction\n[Your top recommendation based on the research, with rationale]',
      }, [s1]);

    // Step 3: Your Review — agent surfaces the brief and asks for user input via AskUserQuestion
    step(wfId, s3, 'Your Review', 'Read the research brief. The agent will ask for your comments and direction — respond via the question prompt in NeonCore.',
      300, 540, 'claude-code',
      {
        ...cc('general'), autoAdvance: false,
        prompt: 'The research brief from the previous step is ready for human review. Do the following:\n\n1. Present the research brief clearly and in full so the user can read it.\n\n2. Then use the AskUserQuestion tool with this exact question:\n"Please share your comments, direction, and priorities for the epic. What should be the focus? Any constraints, preferences, or ideas you want incorporated? (Your response will be passed directly to the epic planning step.)"\n\n3. After the user responds, output their response verbatim under a heading:\n## User Direction\n[user\'s response here]\n\nDo not advance or do anything else — end there.',
      }, [s2]);

    // Step 4: Epic Planning — write full scoped epic based on research + user direction
    step(wfId, s4, 'Epic Planning', 'Write the full scoped epic document based on the research brief and your review comments.',
      300, 770, 'claude-code',
      {
        ...cc('architect'),
        prompt: 'Using the research brief and the user\'s direction from the previous step, write a comprehensive epic scope document in this exact format:\n\n# Epic: [Subject Name]\n\n## Overview\n[2-3 paragraphs: what this epic is, why it matters, what it delivers]\n\n## Business Goals\n- **[Goal 1]**: [description]\n- **[Goal 2]**: [description]\n(continue for all key goals)\n\n## Current State\n| Component | Current State |\n|-----------|---------------|\n[table of what exists today]\n\n## Target State\n| Component | Target State |\n|-----------|---------------|\n[table of what we\'re building toward]\n\n## Constraints\n- **[Constraint 1]**: [description]\n(list all technical, product, or business constraints)\n\n## Task Breakdown\n\n### Phase 1: [Phase Name]\n| Task | Title | Description | Size | Dependencies |\n|------|-------|-------------|------|--------------|\n| [ID]-001 | [Title] | [Description] | S/M/L | None |\n(continue for all tasks)\n\n### Phase 2: [Phase Name]\n[same format]\n\n## Open Questions\n[Numbered list of unresolved decisions]\n\n## Success Metrics\n[How we\'ll know this epic is done and working]',
      }, [s3]);

    // Step 5: Save Epic — write the file to the scoping folder
    step(wfId, s5, 'Save Epic', 'Write the completed epic document to /Users/mannyhenri/Documents/Git/gridlight/.claude/scoping/',
      300, 1000, 'claude-code',
      {
        ...cc('general'),
        prompt: 'Take the epic document written in the previous step and save it as a file.\n\n1. Derive a short kebab-case slug from the epic subject (e.g. "mcp-integration", "voice-search", "offline-mode").\n\n2. Write the full epic content to:\n/Users/mannyhenri/Documents/Git/gridlight/.claude/scoping/EPIC-[slug].md\n\nUse the Write tool to create the file. Do not modify the epic content — copy it exactly.\n\n3. Confirm with: "✅ Epic saved to /Users/mannyhenri/Documents/Git/gridlight/.claude/scoping/EPIC-[slug].md"',
      }, [s4]);

    // Step 6: Create in Jira? — ask user YES/NO, then create epic + tasks if YES
    step(wfId, s6, 'Create in Jira?',
      'Ask whether to create this epic and all its tasks in Jira. If YES: creates the Jira epic, creates every task linked to it, and saves task files to .claude/tasks/.',
      300, 1230, 'claude-code',
      {
        ...cc('general'),
        prompt: 'The epic document has been saved. Now check if the user wants to create it in Jira.\n\n**STEP A — PRESENT THE PLAN**\nFrom the Epic Planning step output, extract and display a concise summary:\n- Epic title\n- Total task count across all phases\n- Phase breakdown (Phase name → N tasks)\n\n**STEP B — ASK THE USER**\nUse the AskUserQuestion tool with this exact question:\n"Create this epic and all [N] tasks in Jira?\n\nReply YES to create everything (you can include your Jira project key, e.g. YES GRD).\nReply NO to skip Jira and finish the workflow."\n\n**STEP C — ACT ON THE RESPONSE**\n\nIf the user replied NO (or anything other than YES):\n→ Output: "⏭️ Skipping Jira — epic saved locally only." and stop.\n\nIf the user replied YES:\n\n1. DISCOVER JIRA CLI — check `jira --version`, `jira-cli --version`, or project scripts to identify the available Jira CLI tool and syntax. Determine the project key (from the user\'s reply or from any existing Jira config/env in the project).\n\n2. CREATE THE JIRA EPIC — create the epic in Jira using the CLI. Use the epic title from the epic document as the summary, and the Overview section as the description. Note the created epic key (e.g. GRD-500).\n\n3. CREATE ALL TASKS — for every task in every phase of the Task Breakdown table, create a Jira issue linked to the epic. For each task:\n   - Summary = task title from the table\n   - Description = full task description from the table\n   - Labels / story points = Size (S=1, M=3, L=5, XL=8)\n   - Epic link = the epic key created above\n   - Note the created issue key (e.g. GRD-501)\n\n4. SAVE TASK FILES — for each created Jira issue, save a task file to /Users/mannyhenri/Documents/Git/gridlight/.claude/tasks/[ISSUE-KEY].md using this exact format:\n```\n# [ISSUE-KEY]: [Task ID] - [Title]\n\n## Task Details\n- **Jira:** [ISSUE-KEY]\n- **Branch:** [ISSUE-KEY-lowercase-kebab-title]\n- **Created:** [today\'s date YYYY-MM-DD]\n- **Epic:** [Epic title]\n- **Phase:** [Phase number and name from Task Breakdown]\n- **Size:** [S/M/L/XL]\n- **Dependencies:** [Dependencies from table, or None]\n\n## Description\n[Full description from the Task Breakdown table]\n\n## Acceptance Criteria\n- [ ] [Derive 3-5 acceptance criteria from the description]\n\n## Technical Notes\n[Any relevant technical context from the epic document]\n\n## Progress\n- [ ] Task started\n```\n\n5. OUTPUT a completion report:\n```\n✅ Jira Epic created: [EPIC-KEY] — [Epic Title]\n\nTasks created ([total]):\n| Issue | Phase | Title | Size |\n|-------|-------|-------|------|\n[one row per task]\n\nTask files saved to /Users/mannyhenri/Documents/Git/gridlight/.claude/tasks/\n```',
      }, [s5]);

    // Step 7: Notify — system notification when research is complete
    step(wfId, s7, 'Notify', 'System notification: Deep Research workflow complete.',
      300, 1460, 'connector',
      { connectorType: 'system-notify', title: 'Deep Research — Done', message: '{{workflowName}} finished. Your epic is ready in NeonCore.' }, [s6]);
  }

  // ── 8. Jira Tasks Validation ──────────────────────────────────────────────
  {
    const wfId = randomUUID();
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID();
    insertWorkflow.run(wfId, 'Jira Tasks Validation',
      'Enter the Jira epic name or key in the launch prompt — each task in the epic is checked against the codebase and transitioned to In QA if requirements are met.', now);

    // Step 1: Fetch all tasks and save to file — output only path + count, not the full dump
    step(wfId, s1, 'Fetch & Save Tasks',
      'Query Jira for every task in the epic, save full details to a local MD file, and output only the file path and task count.',
      300, 80, 'claude-code',
      {
        ...cc('researcher'), workflowContext: true,
        prompt: 'The Jira epic to validate is specified above.\n\n**IMPORTANT: Do NOT output task details to this conversation. Write everything to a file — the next step reads from disk. Process tasks one by one to stay within context limits.**\n\n1. DISCOVER JIRA CLI — Try `jira --version`, `jira-cli --version`, or look for jira scripts in package.json / Makefile. Identify the exact command syntax for this project.\n\n2. FIND PROJECT ROOT — Run `git rev-parse --show-toplevel` to get the absolute project root path.\n\n3. DERIVE SLUG — Convert the epic name to kebab-case (e.g. "Document Generation" → "document-generation").\n\n4. CREATE OUTPUT FILE — Create the directory and initialize the file with a header only:\n   Path: `{project-root}/.gridlight/jira-validation/{epic-slug}-tasks.md`\n   Header:\n   ```\n   # Jira Tasks — [Epic Name]\n   Fetched: [today\'s date]\n   ---\n   ```\n\n5. COLLECT ALL LEAF TASKS (recursive, any depth):\n   Start with the specified epic key. Use a queue/stack approach:\n   a. Fetch the direct children of the current item (use the Jira CLI to list child issues or search by parent/epic-link).\n   b. For each child: if it is itself an epic or has its own children (sub-epic), add it to the queue to recurse into — do NOT add it as a task.\n   c. If it is a leaf task (story, task, subtask, bug — no children of its own), add it to the task list.\n   d. Continue until the queue is empty. You now have all leaf-level tasks from the entire hierarchy.\n   Do not include parent epics in the task list — only leaf issues.\n   Order the final list by creation date.\n   Note the total count.\n\n6. ITERATE THROUGH EACH LEAF KEY — For every issue key, one at a time:\n   a. Fetch the full details for that single issue: title, current status, created date, description, acceptance criteria, technical notes.\n   b. IMMEDIATELY APPEND to the tasks file in this format:\n      ```\n      ## [ISSUE-KEY] — [Title]\n      **Status:** [current status] | **Created:** [date]\n      **Requirements:**\n      [full description and acceptance criteria]\n      ---\n      ```\n   c. Do not accumulate details in memory — fetch one, write one, move on.\n\n7. OUTPUT ONLY these two lines when done:\n   ```\n   Tasks file: {absolute path to the saved file}\n   Total tasks: N\n   ```',
      }, []);

    // Step 2: Read tasks from file, validate each, append results to a second file incrementally
    step(wfId, s2, 'Validate & Save Results',
      'Read the saved tasks file, validate each task against the codebase one by one, append results to a results file as it goes, and transition to "In QA" in Jira when requirements are met.',
      300, 310, 'claude-code',
      {
        ...cc('reviewer'),
        prompt: 'The previous step saved all Jira tasks to a file. Its output contains the file path.\n\n**IMPORTANT: Read the tasks from disk — do NOT rely on the task content being in the conversation context.**\n\n1. READ THE TASKS FILE — From the previous step output, extract the "Tasks file:" path and read it using the Read tool. This gives you the full task list with all requirements.\n\n2. READ THE EPIC SLUG — Derive it from the tasks filename (e.g. `document-generation-tasks.md` → slug is `document-generation`).\n\n3. PREPARE RESULTS FILE (MERGE MODE) — The results file path is:\n   `{same directory}/{epic-slug}-results.md`\n   Check if it already exists:\n   - **If it does NOT exist**: create it with this header:\n     ```\n     # Jira Validation Results — [Epic Name]\n     Validated: [today\'s date]\n     ---\n     ```\n   - **If it DOES exist**: read it and extract every ISSUE-KEY that already has a `VERDICT:` line. These tasks are already validated — skip them in this run. Then append a re-run separator:\n     ```\n     --- Re-run: [today\'s date] ---\n     ```\n   Do not delete or overwrite existing results — only append new ones.\n\n4. FOR EACH TASK in the tasks file (in order) that has NOT already been validated:\n\n   a. READ its requirements from the tasks file.\n\n   b. INVESTIGATE the codebase — use Read, Grep, and Glob to find the relevant implementation. Check:\n      - Is the feature/fix implemented?\n      - Do all details match the requirements exactly?\n      - Are edge cases and error states handled as specified?\n      - Are tests present if required?\n\n   c. DECIDE and ACT:\n      - **MEETS ALL REQUIREMENTS** → run the Jira CLI transition to move it to "Done"\n      - **DOES NOT FULLY MEET** → run the Jira CLI transition to move it to "To Do"\n\n   d. IMMEDIATELY APPEND this result to the results file (do not wait until all tasks are done):\n      ```\n      ## [ISSUE-KEY] — [Title]\n      VERDICT: ✅ Done | ❌ To Do\n      REASON: [1-2 sentences on what was found or what is specifically missing]\n      ---\n      ```\n\n5. After all tasks are processed, OUTPUT ONLY:\n   ```\n   Results file: {absolute path to results file}\n   ✅ Marked Done: N\n   ❌ Marked To Do: N\n   ⏭️ Skipped (already validated): N\n   ```\n\nDo not output individual task verdicts to the conversation — they are saved in the results file.',
      }, [s1]);

    // Step 3: Read results file from disk, compile final report — fresh context, no accumulated data
    step(wfId, s3, 'Summary Report',
      'Read the results file from disk and compile the final validation report with ✅/📋 tables and a summary paragraph.',
      300, 540, 'claude-code',
      {
        ...cc('planner'),
        prompt: 'The previous step saved all validation results to a file. Its output contains the file path.\n\n1. READ THE RESULTS FILE — From the previous step output, extract the "Results file:" path and read it using the Read tool.\n\n2. ALSO READ THE TASKS FILE — Replace "-results.md" with "-tasks.md" in the path to get the tasks file. Read it to get the epic name and any task titles you need.\n\n3. COMPILE THE REPORT in this exact format:\n\n---\n## Jira Epic Validation Report\n**Epic:** [epic name]\n**Validated:** [date from results file] | **Total tasks:** N | **✅ Done:** N | **📋 To Do:** N\n\n### ✅ Done ([count])\n| Issue | Title |\n|-------|-------|\n| [KEY] | [Title] |\n\n### 📋 To Do ([count])\n| Issue | Title | What\'s Missing |\n|-------|-------|----------------|\n| [KEY] | [Title] | [REASON from results file] |\n\n### What\'s Left — Summary\n[Write 2-4 sentences: overall completion state of the epic, the main areas of remaining work, any patterns in what\'s incomplete, and recommended next steps for the team.]\n\n---\n\nThe report above is your full output. Be precise — use the exact issue keys and reasons from the results file.',
      }, [s2], false);

    // Step 4: Notify
    step(wfId, s4, 'Notify',
      'System notification: Jira Tasks Validation workflow complete.',
      300, 770, 'connector',
      { connectorType: 'system-notify', title: 'Jira Validation — Done', message: '{{workflowName}} finished. Check NeonCore for the epic status report.' },
      [s3]);
  }

  // ── 9. Jira Tasks Completion ──────────────────────────────────────────────
  {
    const wfId = randomUUID();
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID();
    insertWorkflow.run(wfId, 'Jira Tasks Completion',
      'TDD-driven loop: completes To Do tasks one by one (understand → failing tests → implement → verify → update Jira + doc → commit → ask to continue). All looping happens inside step 2 — answering YES automatically starts the next task without re-running the workflow.', now);

    // Step 1: Load context — identify epic + results doc paths (minimal output)
    step(wfId, s1, 'Load Context',
      'Read the epic context, identify the results doc and project root. Outputs only the key paths — the work loop in step 2 handles all tasks.',
      300, 80, 'claude-code',
      {
        ...cc('researcher'), workflowContext: true,
        prompt: 'The Jira epic to work on is specified above.\n\n**Goal: identify the scope. Output only the key paths — do not load task details.**\n\n1. FIND PROJECT ROOT — Run `git rev-parse --show-toplevel`.\n\n2. DISCOVER JIRA CLI — Try `jira --version`, `jira-cli --version`, or look for project scripts.\n\n3. DERIVE EPIC SLUG — Convert the epic name to kebab-case (e.g. "Document Generation" → "document-generation").\n\n4. LOCATE THE RESULTS DOC — Expected path: `{project-root}/.gridlight/jira-validation/{epic-slug}-results.md`. Check if it exists.\n\n5. OUTPUT ONLY these lines:\n```\nEpic: [epic name]\nEpic slug: [kebab-slug]\nProject root: [absolute path]\nJira CLI: [command name]\nResults doc: [absolute path] (exists: YES/NO)\nTasks doc: [absolute path to {slug}-tasks.md]\n```',
      }, []);

    // Step 2: The main work loop — agent iterates internally through tasks
    step(wfId, s2, 'Work Through Tasks',
      'Main loop. For each To Do task: fetch Jira requirements → explore code → write failing tests → implement → run tests → update Jira + doc → commit → AskUserQuestion to continue. Answer YES to auto-start next task, NO to stop.',
      300, 310, 'claude-code',
      {
        ...cc('backend'),
        prompt: 'The previous step identified the epic, results doc path, and project root. You will now work through To Do tasks one at a time in a loop — do NOT stop after a single task unless the user says so or all tasks are done.\n\n**OVERALL LOOP — repeat until user says NO or no To Do tasks remain:**\n\n### PHASE 1 — PICK NEXT TASK\n- Read the results doc (or tasks doc if no results doc exists). Find the first task marked `VERDICT: ❌ To Do`.\n- If NO To Do tasks remain: output `🎉 All tasks in the epic are complete!` and END the loop. Do not call AskUserQuestion.\n- Otherwise note the ISSUE-KEY and Title — this is the current task.\n\n### PHASE 2 — UNDERSTAND\n- Use the Jira CLI to fetch full details for this one issue: description, acceptance criteria, technical notes.\n- Read the section for this issue in the tasks doc to cross-reference its originally-captured requirements.\n- Read the REASON line for this issue in the results doc — that tells you what was missing during validation.\n- Use Read/Grep/Glob to explore the codebase: what already exists? what is missing? where should the new code live? what patterns to follow?\n\n### PHASE 3 — WRITE TESTS FIRST (TDD)\n- Find the test file(s) for this area of the codebase.\n- Write real tests based on the requirements — NOT based on what the implementation will look like.\n- Each test must assert meaningful behavior: happy path + at least 2 edge cases + at least 1 error state per requirement.\n- Run the tests with Bash and CONFIRM they FAIL (since the implementation does not exist yet). If they pass before code is written, the tests are wrong — rewrite them.\n\n### PHASE 4 — IMPLEMENT\n- Write the minimum code needed to satisfy the requirements and make the tests pass.\n- Follow existing patterns, conventions, and architecture.\n- Do NOT modify the tests to make them pass — fix the implementation.\n- Handle error states and edge cases as specified.\n\n### PHASE 5 — VERIFY (with retry)\n- Run the tests using Bash. If any fail: go back to PHASE 4, fix the implementation, run again. Do this up to 3 times.\n- If after 3 attempts tests still fail: STOP the loop, output the failure details, and do not call AskUserQuestion.\n- Also run the full test suite (not just the new tests) to confirm nothing else broke.\n\n### PHASE 6 — FINALIZE\n- Use the Jira CLI to transition this issue to "Done".\n- In the results doc, find this issue\'s section and change:\n  - `VERDICT: ❌ To Do` → `VERDICT: ✅ Done`\n  - The REASON line to: `Implemented in this run — [brief 1-sentence description].`\n- Stage all changes (implementation files, test files, updated results doc).\n- Commit with message: `[ISSUE-KEY] [Title] — implement per Jira requirements`\n- Output a short confirmation: `✅ [ISSUE-KEY] done · commit [hash]`\n\n### PHASE 7 — ASK TO CONTINUE\n- Read the results doc again to find the NEXT task with `VERDICT: ❌ To Do`.\n- If no more To Do tasks: output `🎉 All tasks in the epic are complete!` and END the loop.\n- Otherwise use the AskUserQuestion tool with this exact message:\n  "✅ [just-completed KEY] — [just-completed title] done.\n\n  Next: [NEXT-KEY] — [next title]\n  [1-line description of what the next task requires]\n\n  Continue automatically to the next task? (YES / NO)"\n- If user replies YES (or anything starting with Y): GO BACK TO PHASE 1 and process the next task.\n- If user replies NO (or anything else): output `⏸️ Paused at user request. Resume anytime.` and END the loop.\n\n**Critical: only one task active at a time. Complete each phase fully before moving to the next. Never skip PHASE 3 (tests before implementation). The loop is mandatory — do not stop after one task unless the user says NO or tasks are exhausted or 3 consecutive test failures occur.**',
      }, [s1]);

    // Step 3: Notify
    step(wfId, s3, 'Notify',
      'System notification: Jira Tasks Completion run finished.',
      300, 540, 'connector',
      { connectorType: 'system-notify', title: 'Jira Tasks Completion — Done', message: '{{workflowName}} finished. Check NeonCore for the session report.' },
      [s2]);
  }

  // ── 10. Product Strategy Session ─────────────────────────────────────────
  {
    const wfId = randomUUID();
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(), s5 = randomUUID(), s6 = randomUUID(), s7 = randomUUID(), s8 = randomUUID(), s9 = randomUUID();
    insertWorkflow.run(wfId, 'Product Strategy Session',
      'Set the workflow description to the product/feature being reviewed. Premise challenge → alternatives → dream state → dual-voice analysis (CEO vs PM) → 10-dimension strategy review → action plan → capture learnings.', now);

    step(wfId, s1, 'Context & Premise',
      'Understand what is being built and challenge the core premise. Surface hidden assumptions before the team gets attached.',
      300, 80, 'claude-code',
      {
        ...cc('researcher'), workflowContext: true,
        prompt: 'The product or feature to review is described above. Your first job is to deeply understand it and then challenge its premise.\n\n**PHASE 1 — UNDERSTAND THE SUBJECT**\nRead the description carefully. Research the local codebase (if relevant) using Grep/Glob/Read to understand current state. Identify:\n- What exactly is being built or changed\n- Who the target user is and what problem they have\n- What success looks like from the user\'s perspective\n\n**PHASE 2 — CHALLENGE THE PREMISE**\nEvery product assumption deserves scrutiny. Challenge each one:\n1. Why does this problem need solving NOW? What changes if we wait 6 months?\n2. Is the proposed solution the most direct path to the user\'s underlying need — or is it solving a proxy problem?\n3. What assumptions about user behavior are baked in? Are they validated?\n4. What is the riskiest assumption in this plan? What would invalidate the whole approach?\n5. Could this be solved with something 10x simpler that already exists?\n\n**OUTPUT**\n```\n## Subject\n[1-2 sentences: what this is]\n\n## Core Premise\n[The fundamental bet this product/feature is making]\n\n## Premise Challenges\n| Assumption | Why It Could Be Wrong | Risk Level |\n|------------|----------------------|------------|\n[3-5 rows]\n\n## Riskiest Assumption\n[The single assumption that, if wrong, kills the whole idea — and why]\n```',
      }, []);

    step(wfId, s2, 'Alternatives Analysis',
      'Explore all competing approaches — including doing nothing, buying vs building, and radically different framings.',
      300, 255, 'claude-code',
      {
        ...cc('architect'),
        prompt: 'Using the context and premise from the previous step, map the full solution space.\n\nDo NOT just list minor variations of the same idea. Explore genuinely different approaches:\n\n**Alternative 1: Do Nothing**\nWhat happens if we ship nothing? Can users work around this? What is the cost of inaction?\n\n**Alternative 2: Buy / Integrate**\nIs there an existing product, library, or API that already solves 80% of this? What would it cost? What would we lose?\n\n**Alternative 3: Narrow Scope Dramatically**\nWhat is the smallest possible version that still delivers meaningful value? What are we overbuilding?\n\n**Alternative 4: Reframe the Problem**\nIf we asked "what is the user\'s deeper need?" rather than "how do we build X?" — what entirely different solution appears?\n\n**Alternative 5: The Original Proposal**\nDescribe the proposed approach as a distinct option with the same rigor as the others.\n\n**OUTPUT**\n```\n## Solution Alternatives\n\n| Alternative | Core Idea | Biggest Advantage | Biggest Risk | Effort |\n|-------------|-----------|-------------------|--------------|--------|\n[one row per alternative]\n\n## Head-to-Head\n[Pick the 2 most interesting alternatives and explain the key trade-off between them in 2-3 sentences]\n\n## Recommendation\n[Which alternative looks strongest and why — be direct]\n```',
      }, [s1]);

    step(wfId, s3, 'Dream State',
      'Articulate the ideal end-state with all constraints removed. What does complete success look like in 3 years?',
      300, 430, 'claude-code',
      {
        ...cc('researcher'),
        prompt: 'Imagine it is 3 years from now and this product/feature has succeeded beyond expectations. Constraints of time, team size, and technical debt have been removed. What does the world look like?\n\nThis is not a roadmap — it is a north star. Write it in present tense as if it has already happened.\n\n**DREAM STATE DOCUMENT**\n\n```\n## Dream State: [Product/Feature Name]\n\n### The User Experience (in 3 years)\n[Write 2-3 paragraphs from the perspective of a user in the ideal future. What does their day look like? How does this product fit into it? Be concrete and specific — use a real user story, not abstract language.]\n\n### The Product (in 3 years)\n[What has been built? What metrics prove success? What does the product do that seemed impossible 3 years ago?]\n\n### What Had to Be True\n[The 3-5 things that had to happen for this dream state to be reached — these are the strategic bets]\n\n### The Gap\n[What is the distance between today and this dream state? What is the hardest thing to close?]\n\n### The Minimum Viable Dream\n[What is the smallest version of this that preserves the soul of the dream? Where is the line between "not enough" and "enough to validate the bet"?]\n```',
      }, [s2]);

    step(wfId, s4, 'Dual Voice Analysis',
      'CEO lens vs PM lens — two distinct perspectives debate the product in a structured dialogue.',
      300, 605, 'claude-code',
      {
        ...cc('planner'),
        prompt: 'Conduct a dual-voice debate between two distinct perspectives on this product/feature. Write as if two smart, opinionated people are actually disagreeing.\n\n**THE CEO VOICE** — thinks about: business model, market size, competitive moat, burn rate, defensibility, timing, investor narrative, existential risk.\n\n**THE PM VOICE** — thinks about: user pain intensity, behavior change required, retention loops, feedback cycles, what users actually asked for vs what they need, scope creep risk, shipping velocity.\n\nFormat as a real dialogue. Each voice gets to respond to the other. Minimum 3 exchanges per topic.\n\n**Topics to debate:**\n1. Is this the right thing to build right now?\n2. What does success look like in 6 months?\n3. What would we cut if we had to ship in half the time?\n4. What is the most likely way this fails?\n\n**OUTPUT**\n```\n## Dual Voice Analysis\n\n### 1. Is this the right thing to build right now?\n**CEO:** [position]\n**PM:** [response / pushback]\n**CEO:** [rebuttal]\n**PM:** [synthesis or escalation]\n\n[repeat for each topic]\n\n### Resolution\n[Where the two voices agree. Where they still disagree. What question remains open that only data can answer.]\n```',
      }, [s3]);

    step(wfId, s5, 'Strategy Review',
      '10-dimension review: market fit, technical feasibility, UX, competition, risk, timing, monetization, team, metrics, and moat.',
      300, 780, 'claude-code',
      {
        ...cc('reviewer'),
        prompt: 'Conduct a structured 10-dimension product strategy review. Be direct — call out weaknesses as clearly as strengths.\n\nFor each dimension: give a 2-4 sentence assessment, a score (1-10), and the single most important action.\n\n```\n## Product Strategy Review: [Name]\n\n### 1. Market Fit (Score: N/10)\n[Does this solve a real pain for a large enough market? Is the market growing or shrinking?]\n**Key action:** [Most important thing to do here]\n\n### 2. Technical Feasibility (Score: N/10)\n[Can we build this with our current team and stack? What are the hardest technical challenges?]\n**Key action:** [Most important thing to do here]\n\n### 3. User Experience (Score: N/10)\n[How much behavior change is required? Is the UX intuitive? Where will users get stuck?]\n**Key action:** [Most important thing to do here]\n\n### 4. Competitive Position (Score: N/10)\n[Who else is solving this? What is our differentiation? Could a well-funded competitor copy this in 6 months?]\n**Key action:** [Most important thing to do here]\n\n### 5. Risk Profile (Score: N/10)\n[What are the top 3 risks? Technical, market, execution? Which is most likely to kill the project?]\n**Key action:** [Most important thing to do here]\n\n### 6. Timing (Score: N/10)\n[Why now? What has changed that makes this possible or necessary today vs 2 years ago?]\n**Key action:** [Most important thing to do here]\n\n### 7. Monetization (Score: N/10)\n[Is there a clear path to revenue? Does the pricing model match user psychology?]\n**Key action:** [Most important thing to do here]\n\n### 8. Team Readiness (Score: N/10)\n[Does the team have the skills, capacity, and context to execute this well?]\n**Key action:** [Most important thing to do here]\n\n### 9. Success Metrics (Score: N/10)\n[Are the success metrics clear, measurable, and leading indicators — not just lagging vanity metrics?]\n**Key action:** [Most important thing to do here]\n\n### 10. Moat & Defensibility (Score: N/10)\n[What keeps competitors from copying this once it works? Network effects, data, switching costs, brand?]\n**Key action:** [Most important thing to do here]\n\n---\n## Overall Score: [average]/10\n## Verdict: [GO / GO WITH CHANGES / NO-GO]\n## Top 3 Priorities Before Moving Forward:\n1. [Highest-leverage action]\n2. [Second priority]\n3. [Third priority]\n```',
      }, [s4]);

    step(wfId, s6, 'Action Plan',
      'Concrete next steps with clear owners, deadlines, and success criteria. Requires human review before accepting.',
      300, 955, 'claude-code',
      {
        ...cc('planner'),
        prompt: 'Using all the analysis from the previous steps, compile a concrete action plan. This should be opinionated — don\'t hedge. Pick the best path and commit to it.\n\n```\n## Action Plan: [Product/Feature Name]\n\n### Strategic Decision\n[State the GO/NO-GO/CHANGE recommendation clearly. One paragraph on why.]\n\n### Immediate Actions (next 2 weeks)\n| Priority | Action | Owner | Done When |\n|----------|--------|-------|----------|\n[3-5 rows — these are the blockers and validators that determine the path]\n\n### Phase 1 (first 6 weeks)\n[What gets built? What gets validated? What gets cut?]\n\n| Week | Milestone | Success Criteria |\n|------|-----------|------------------|\n[one row per key milestone]\n\n### Key Decisions Still Open\n| Decision | Who Decides | Deadline | Impact If Wrong |\n|----------|-------------|----------|-----------------|\n[decisions that must be made before building starts]\n\n### What We Are NOT Building\n[Explicit list of things that are out of scope — to prevent scope creep]\n\n### North Star Metric\n[The single number that tells you in 6 months whether this worked]\n```',
      }, [s5], false);

    step(wfId, s7, 'Capture Learnings',
      'Save the key strategy insights to project learnings for future workflow context.',
      300, 1130, 'connector',
      { connectorType: 'capture-learnings', includeDepOutput: true }, [s6]);

    step(wfId, s8, 'Save to Project',
      'Write the full strategy session output as a Markdown file in the linked project repo.',
      300, 1305, 'connector',
      { connectorType: 'save-to-project' }, [s7]);

    step(wfId, s9, 'Notify',
      'System notification: Product Strategy Session complete.',
      300, 1480, 'connector',
      { connectorType: 'system-notify', title: 'Product Strategy Session — Done', message: '{{workflowName}} complete. Review the action plan in NeonCore.' }, [s8]);
  }

  // ── 11. Engineering Architecture Review ──────────────────────────────────
  {
    const wfId = randomUUID();
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(), s5 = randomUUID(), s6 = randomUUID(), s7 = randomUUID(), s8 = randomUUID();
    insertWorkflow.run(wfId, 'Engineering Architecture Review',
      'Set the workflow description to the system or feature under review. Architecture mapping → bottleneck analysis → alternative approaches → recommendation → implementation roadmap → human review → capture learnings.', now);

    step(wfId, s1, 'Architecture Mapping',
      'Map the current system architecture: components, data flows, dependencies, and boundaries.',
      300, 80, 'claude-code',
      {
        ...cc('architect'), workflowContext: true,
        prompt: 'The system or feature to review is described above. Map its current architecture using Read, Grep, and Glob tools to explore the codebase.\n\n**PHASE 1 — COMPONENT INVENTORY**\nList every significant component involved: files, modules, services, APIs, DB tables, queues, caches, external dependencies.\n\n**PHASE 2 — DATA FLOW TRACE**\nTrace the primary data flows end-to-end. For each flow:\n- Start point (user action / event / cron)\n- Each layer it passes through\n- Final state change or output\n- Where errors can occur\n\n**PHASE 3 — DEPENDENCY MAP**\nIdentify:\n- Internal dependencies (what depends on what within the codebase)\n- External dependencies (third-party services, APIs, packages)\n- Circular dependencies or tight coupling\n\n**OUTPUT**\n```\n## Architecture Map: [System/Feature Name]\n\n### Components\n| Component | Type | File(s) | Responsibility |\n|-----------|------|---------|----------------|\n[one row per component]\n\n### Primary Data Flows\n[Flow 1: name]\n→ [step1] → [step2] → [step3] → [output]\n[repeat per flow]\n\n### Dependency Graph (prose)\n[Describe the most critical dependencies and coupling points in 3-5 bullet points]\n\n### External Dependencies\n| Service/Package | Purpose | Risk if Unavailable |\n|-----------------|---------|---------------------|\n[one row per external dep]\n```',
      }, []);

    step(wfId, s2, 'Bottleneck & Risk Analysis',
      'Identify structural weaknesses, performance bottlenecks, scalability limits, and technical debt hotspots.',
      300, 255, 'claude-code',
      {
        ...cc('reviewer'),
        prompt: 'Using the architecture map from the previous step, identify everything that is likely to cause problems as the system scales or changes.\n\n**Check each of the following categories:**\n\n**Performance Bottlenecks**\n- N+1 query patterns\n- Synchronous operations that should be async\n- Missing indexes or inefficient queries\n- Large payloads or over-fetching\n- Missing caching on hot read paths\n\n**Scalability Limits**\n- Single points of failure\n- Shared mutable state that prevents horizontal scaling\n- In-memory storage that won\'t survive a restart\n- Tight coupling that prevents independent scaling of components\n\n**Technical Debt Hotspots**\n- Files with too many responsibilities (God objects/files)\n- Duplicated logic that should be centralized\n- Hardcoded configuration that should be dynamic\n- Missing abstraction layers that make change expensive\n\n**Security Risks**\n- Missing auth checks on internal routes\n- Unvalidated inputs flowing into queries or commands\n- Sensitive data in logs or error messages\n- Missing rate limiting on expensive endpoints\n\n**OUTPUT**\n```\n## Bottleneck & Risk Analysis\n\n| Category | Issue | Severity | Impact |\n|----------|-------|----------|--------|\n[critical/high/medium/low — one row per issue]\n\n## Top 3 Risks (Detailed)\n### Risk 1: [Name]\n[What it is, why it matters, what breaks when it does]\n\n[repeat for risks 2 and 3]\n\n## Overall Health: [Good / Needs Work / Critical]\n```',
      }, [s1]);

    step(wfId, s3, 'Alternative Approaches',
      'Explore fundamentally different ways to solve the same problem, including industry patterns and trade-off analysis.',
      300, 430, 'claude-code',
      {
        ...cc('architect'),
        prompt: 'Given the current architecture and the risks identified, explore alternative architectural approaches.\n\nDo not just propose minor variations — consider genuinely different designs:\n\n**Alternative 1: Minimal Change**\nWhat is the smallest refactor that eliminates the top risks without restructuring?\n\n**Alternative 2: Industry Pattern**\nWhat well-established pattern (CQRS, event sourcing, hexagonal architecture, micro-frontends, etc.) addresses the identified problems? How would it apply here?\n\n**Alternative 3: Full Redesign**\nIf we started from scratch with everything we know now, what would we build? What does the ideal architecture look like?\n\n**Alternative 4: Incremental Migration**\nA phased approach that moves toward Alternative 3 without a big-bang rewrite. What are the phases?\n\n**OUTPUT**\n```\n## Architectural Alternatives\n\n| Alternative | Core Idea | Pros | Cons | Effort |\n|-------------|-----------|------|------|--------|\n[one row per alternative — Effort: days/weeks/months]\n\n## Trade-off Analysis\n[For the 2 most interesting alternatives, write 3-4 sentences on the fundamental trade-off]\n\n## Recommended Direction\n[Direct recommendation with rationale]\n```',
      }, [s2]);

    step(wfId, s4, 'Architecture Recommendation',
      'Concrete design proposal with component diagram, interfaces, and explicit trade-off decisions. Requires human review.',
      300, 605, 'claude-code',
      {
        ...cc('architect'),
        prompt: 'Based on the analysis so far, write the concrete architecture recommendation. Be specific — include actual file paths, interface names, and data structures.\n\n```\n## Architecture Recommendation: [System/Feature Name]\n\n### Proposed Design\n[2-3 paragraphs describing the recommended architecture in plain English. Why this over the alternatives.]\n\n### Component Changes\n| Component | Current State | Proposed State | Reason |\n|-----------|--------------|----------------|--------|\n[one row per component that changes — "NEW" for additions, "REMOVE" for deletions]\n\n### New Interfaces / Contracts\n[For each new interface, type, or API contract being introduced]\n```typescript\n// or the relevant language\ninterface [Name] {\n  [fields]\n}\n```\n\n### Migration Path\n[How do we get from current state to proposed state without breaking prod?]\n1. [Step 1 — can be done independently]\n2. [Step 2 — depends on step 1]\n[continue]\n\n### Explicit Trade-offs\n| We are choosing | Over | Because |\n|-----------------|------|---------|\n[list the deliberate trade-offs in this design]\n\n### What This Does NOT Solve\n[Things explicitly out of scope — to prevent scope creep in implementation]\n\n### Success Criteria\n[How will we know the new architecture is working? Metrics and observable behaviors.]\n```',
      }, [s3], false);

    step(wfId, s5, 'Implementation Roadmap',
      'Phased implementation plan with milestones, dependencies, and rollback strategies.',
      300, 780, 'claude-code',
      {
        ...cc('planner'),
        prompt: 'Using the Architecture Recommendation, create a detailed implementation roadmap that a team can follow.\n\n```\n## Implementation Roadmap\n\n### Phase 1: Foundation (estimated: [timeframe])\n**Goal:** [What this phase achieves and why it must come first]\n\n| Task | File(s) | Description | Done When |\n|------|---------|-------------|----------|\n[one row per task — keep tasks small enough to complete in 1 day]\n\n**Phase 1 Definition of Done:**\n- [ ] [observable criterion 1]\n- [ ] [observable criterion 2]\n**Rollback plan:** [How to undo Phase 1 if it causes problems]\n\n### Phase 2: Core Changes (estimated: [timeframe])\n[same structure]\n\n### Phase 3: Cleanup & Optimization (estimated: [timeframe])\n[same structure]\n\n---\n### Critical Path\n[The 3-5 tasks that everything else depends on — these are the highest-risk items]\n\n### Parallel Work\n[Tasks that can be done simultaneously without blocking each other]\n\n### Total Estimated Effort\n[Sum of all phases with confidence range — e.g. "8-12 engineering days"]\n```',
      }, [s4]);

    step(wfId, s6, 'Capture Learnings',
      'Save architecture decisions and rationale to project learnings.',
      300, 955, 'connector',
      { connectorType: 'capture-learnings', includeDepOutput: true }, [s5]);

    step(wfId, s7, 'Save to Project',
      'Write the full architecture review as a Markdown file in the linked project repo.',
      300, 1130, 'connector',
      { connectorType: 'save-to-project' }, [s6]);

    step(wfId, s8, 'Notify',
      'System notification: Engineering Architecture Review complete.',
      300, 1305, 'connector',
      { connectorType: 'system-notify', title: 'Architecture Review — Done', message: '{{workflowName}} complete. Review the implementation roadmap in NeonCore.' }, [s7]);
  }

  // ── 12. Full QA Review ────────────────────────────────────────────────────
  {
    const wfId = randomUUID();
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(), s5 = randomUUID(), s6 = randomUUID(), s7 = randomUUID(), s8 = randomUUID();
    insertWorkflow.run(wfId, 'Full QA Review',
      'Set the workflow description to the feature or URL being tested. Golden path → edge cases → error handling → performance → security → accessibility → QA report → notify.', now);

    step(wfId, s1, 'Golden Path Testing',
      'Test the primary happy path end-to-end. Every core user journey must work correctly.',
      300, 80, 'claude-code',
      {
        ...cc('tester'), workflowContext: true,
        prompt: 'The feature or system to QA test is described above. Begin with the golden path — the primary happy path that most users will take.\n\n**PHASE 1 — IDENTIFY GOLDEN PATHS**\nFrom the description (and by reading the relevant code with Grep/Glob/Read), identify the 3-5 primary user journeys. For each journey: start point → steps → expected end state.\n\n**PHASE 2 — TEST EACH GOLDEN PATH**\nFor each journey, trace through the code to verify it works correctly:\n1. Follow the code execution path step by step\n2. Check that each step produces the expected output\n3. Verify the final state matches what the user would expect\n4. Check that error states are handled gracefully\n\n**PHASE 3 — OUTPUT RESULTS**\n```\n## Golden Path Test Results\n\n| Journey | Steps Tested | Result | Notes |\n|---------|-------------|--------|-------|\n| [name] | [N steps] | ✅ PASS / ❌ FAIL | [what works or what broke] |\n\n### Failures (if any)\n#### [Journey Name]\n- **Expected:** [what should happen]\n- **Actual:** [what actually happens]\n- **File:Line:** [where the bug is]\n- **Severity:** critical / high / medium\n\n### Golden Path Summary\nPassed: N/N | Failed: N/N\n```',
      }, []);

    step(wfId, s2, 'Edge Case Testing',
      'Test boundary conditions, empty states, maximum values, concurrent operations, and unusual but valid inputs.',
      300, 255, 'claude-code',
      {
        ...cc('tester'),
        prompt: 'Test edge cases and boundary conditions. These are the cases that work in demos but fail in production.\n\n**Edge case categories to test:**\n\n**Empty / Zero / Null States**\n- Empty lists, zero counts, null/undefined values\n- What shows when there is no data?\n- What happens on first use before any data exists?\n\n**Boundary Values**\n- Minimum and maximum allowed values\n- Exactly at the limit vs one over/under\n- Very large datasets (100+ items)\n- Very long strings in text fields\n\n**Concurrent / Race Conditions**\n- Two operations happening at the same time\n- Rapid repeated clicks/calls\n- Navigation away during an async operation\n\n**Unusual But Valid Inputs**\n- Special characters in text fields\n- Unicode and emoji in string fields\n- Very large numbers where numbers are expected\n- Unexpected but valid data types\n\n**State Transitions**\n- What happens when status changes mid-operation?\n- Refresh during a long operation\n- Back button after a destructive action\n\nFor each edge case tested, document: input → expected behavior → actual behavior → PASS/FAIL.\n\n```\n## Edge Case Results\n| Category | Case | Expected | Actual | Status |\n|----------|------|----------|--------|--------|\n[one row per test]\n\n### Critical Failures\n[Detailed description of any FAIL results with file:line pointers]\n\nEdge Cases: N tested | N passed | N failed\n```',
      }, [s1]);

    step(wfId, s3, 'Error Handling Review',
      'Verify that every error path surfaces a useful message, fails gracefully, and recovers correctly.',
      300, 430, 'claude-code',
      {
        ...cc('reviewer'),
        prompt: 'Review all error handling paths in the feature or system. Poor error handling is the most common source of production incidents.\n\n**Check these error categories:**\n\n**Network / API Failures**\n- What happens when an API call times out?\n- What happens when the server returns 500?\n- What happens when the response is malformed?\n\n**User Input Errors**\n- Are validation errors surfaced clearly to the user?\n- Are form fields reset correctly after an error?\n- Is the user told specifically what went wrong and how to fix it?\n\n**Auth / Permission Errors**\n- What happens when a session expires mid-operation?\n- Are 401/403 responses handled with a redirect to login?\n- Are permission errors shown as helpful messages vs cryptic failures?\n\n**Async Operation Failures**\n- Are all promises awaited and their rejections caught?\n- Are loading states cleared when operations fail?\n- Does the UI recover to a usable state after an error?\n\n**Data Corruption Prevention**\n- Is there protection against partial writes?\n- Are transactions used where multiple DB operations must succeed together?\n- Is there a way to undo a destructive operation?\n\n```\n## Error Handling Review\n| Error Type | Handler Found | Quality | Notes |\n|------------|--------------|---------|-------|\n| [category] | YES/NO/PARTIAL | ✅ Good / ⚠️ Weak / ❌ Missing | [file:line if relevant] |\n\n### Unhandled Error Paths\n[Detailed description of any missing error handlers with file:line pointers]\n\n### Summary\nError paths checked: N | Well-handled: N | Weakly handled: N | Missing: N\n```',
      }, [s2]);

    step(wfId, s4, 'Performance Assessment',
      'Identify slow queries, large payloads, missing indexes, and operations that will not scale.',
      300, 605, 'claude-code',
      {
        ...cc('reviewer'),
        prompt: 'Assess the performance characteristics of the feature or system. Look for patterns that work fine with 10 users but fail with 1000.\n\n**Check for:**\n\n**Database Performance**\n- N+1 query patterns (fetching one item per loop iteration)\n- Missing WHERE clause indexes on frequently-queried columns\n- SELECT * where specific columns suffice\n- Queries inside loops or map/forEach calls\n- Unbounded queries with no LIMIT\n\n**Network Performance**\n- Over-fetching (large responses where small ones suffice)\n- Chatty APIs (many small requests where one batch request would work)\n- Missing pagination on list endpoints\n- Large payloads in WebSocket events\n\n**Rendering / UI Performance**\n- Expensive computations on every render\n- Missing memoization on computed values\n- Large lists without virtualization\n- Unnecessary re-renders from unstable references\n\n**Memory**\n- Long-lived in-memory stores that grow unbounded\n- Event listeners added but never removed\n- Timers/intervals not cleared on component unmount\n\n```\n## Performance Assessment\n| Category | Issue | File:Line | Estimated Impact | Priority |\n|----------|-------|-----------|-----------------|----------|\n[one row per issue found — Priority: critical/high/medium/low]\n\n### Top Performance Risk\n[The single most impactful performance issue found — describe it in detail]\n\n### Summary\nIssues found: N (critical: X, high: Y, medium: Z, low: W)\n```',
      }, [s3]);

    step(wfId, s5, 'Security Scan',
      'Check for OWASP Top 10, auth gaps, input validation, and credential exposure.',
      300, 780, 'quality-gate',
      gate('security'), [s4]);

    step(wfId, s6, 'Accessibility Review',
      'Verify ARIA labels, keyboard navigation, color contrast, focus management, and screen reader compatibility.',
      300, 955, 'claude-code',
      {
        ...cc('reviewer'),
        prompt: 'Review the accessibility of the feature or system. Accessibility is not optional — it is a quality bar.\n\n**Check each category:**\n\n**ARIA & Semantic HTML**\n- Do interactive elements (buttons, links, inputs) have descriptive labels?\n- Are `aria-label` or `aria-labelledby` used where the visual label is not in the DOM?\n- Is semantic HTML used (button, nav, main, section, h1-h6) rather than divs with click handlers?\n- Are modal dialogs marked with `role="dialog"` and `aria-modal="true"`?\n\n**Keyboard Navigation**\n- Can all interactive elements be reached with Tab?\n- Is the tab order logical (top-to-bottom, left-to-right)?\n- Do modals trap focus correctly (Tab cycles within the modal)?\n- Is there a way to close every modal with Escape?\n- Are custom components (dropdowns, sliders) keyboard-operable?\n\n**Focus Management**\n- Does focus move to the modal when it opens?\n- Does focus return to the trigger element when a modal closes?\n- Are focus styles visible (not hidden with `outline: none` without replacement)?\n\n**Color & Contrast**\n- Do text/background combinations meet WCAG AA (4.5:1 for normal text, 3:1 for large text)?\n- Is information conveyed by color alone (without a secondary indicator)?\n\n**Screen Reader**\n- Do loading states have appropriate `aria-busy` or live region announcements?\n- Are error messages announced to screen readers (not just visually displayed)?\n- Are icon-only buttons labeled?\n\n```\n## Accessibility Review\n| Category | Issue | Element/File | WCAG Criterion | Severity |\n|----------|-------|-------------|----------------|----------|\n[one row per issue — Severity: critical/high/medium/low]\n\n### Summary\nIssues found: N | Critical: N | High: N | Medium: N | Low: N\nOverall accessibility score: N/10\n```',
      }, [s5]);

    step(wfId, s7, 'QA Report',
      'Compile the full QA report with health score, issue table, and recommendations. Requires human review.',
      300, 1130, 'claude-code',
      {
        ...cc('planner'),
        prompt: 'Compile the complete QA report using all findings from every previous step.\n\n```\n## QA Report: [Feature/System Name]\n**Date:** [today]\n\n---\n\n## Health Score: N/100\n[Deduct points: Critical issue = -15, High = -8, Medium = -3, Low = -1. Start at 100.]\n\n## Summary\n[2-3 sentences: overall quality, biggest concerns, what works well]\n\n---\n\n## All Issues\n| ID | Severity | Category | Description | File:Line |\n|----|----------|----------|-------------|----------|\n| QA-001 | critical | [category] | [description] | [file:line] |\n[one row per issue found across all steps]\n\n---\n\n## Golden Path: [✅ All Pass / ❌ N Failures]\n## Edge Cases: N tested, N failed\n## Error Handling: N paths, N gaps\n## Performance: N issues (N critical)\n## Security: [Clean / N issues]\n## Accessibility: N/10\n\n---\n\n## Critical Issues (fix before ship)\n[Bulleted list — each with file:line and exact fix needed]\n\n## Recommended Fixes (high priority)\n[Bulleted list]\n\n## Nice to Have (medium/low)\n[Bulleted list]\n\n---\n\n## Verdict\n**[SHIP / SHIP WITH FIXES / DO NOT SHIP]**\n[One sentence rationale]\n```',
      }, [s6], false);

    step(wfId, s8, 'Notify',
      'System notification: Full QA Review complete.',
      300, 1305, 'connector',
      { connectorType: 'system-notify', title: 'Full QA Review — Done', message: '{{workflowName}} complete. Review the QA report in NeonCore.' }, [s7]);
  }

  // ── 13. Bug Investigation ─────────────────────────────────────────────────
  {
    const wfId = randomUUID();
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(), s5 = randomUUID(), s6 = randomUUID(), s7 = randomUUID();
    insertWorkflow.run(wfId, 'Bug Investigation',
      'Set the workflow description to the bug being investigated. Reproduce → root cause → impact assessment → fix plan (human gate) → implement → verify → capture learnings.', now);

    step(wfId, s1, 'Reproduce the Bug',
      'Establish a reliable reproduction case. Understand exactly what happens vs what should happen.',
      300, 80, 'claude-code',
      {
        ...cc('reviewer'), workflowContext: true,
        prompt: 'The bug to investigate is described above. Your first job is to understand and reproduce it.\n\n**PHASE 1 — UNDERSTAND THE SYMPTOMS**\nFrom the description, extract:\n- What action triggers the bug\n- What the user observes (the symptom)\n- What the correct behavior should be\n- When it first appeared (if known)\n- How reliably it occurs (always / sometimes / rarely)\n\n**PHASE 2 — EXPLORE THE CODE PATH**\nUsing Grep, Glob, and Read tools, trace the code path that handles the action described in the bug:\n1. Find the entry point (API route, event handler, component, cron job, etc.)\n2. Follow execution through every function call\n3. Identify where the actual behavior diverges from the expected behavior\n4. Note any conditions, flags, or state that could affect the behavior\n\n**PHASE 3 — IDENTIFY REPRODUCTION CONDITIONS**\nDetermine:\n- The exact inputs that trigger the bug\n- Any preconditions (specific state, user role, data configuration)\n- Whether the bug is deterministic or dependent on timing/environment\n\n**OUTPUT**\n```\n## Bug Reproduction Report\n\n### Bug Summary\n[1-2 sentences: what it is]\n\n### Symptom vs Expected Behavior\n| | Description |\n|--|-------------|\n| **Symptom (actual)** | [what happens] |\n| **Expected behavior** | [what should happen] |\n\n### Reproduction Steps\n1. [Step 1]\n2. [Step 2]\n[continue]\n**Preconditions:** [any required state]\n**Reliability:** [always / ~X% of the time / specific conditions]\n\n### Code Path Traced\n[entry point] → [function] → [function] → ... → [point of failure]\n\n### Point of Failure\n**File:Line:** [path:linenum]\n**Why:** [brief explanation of what the code does wrong here]\n```',
      }, []);

    step(wfId, s2, 'Root Cause Analysis',
      'Trace the bug to its deepest cause. Distinguish symptom from root cause.',
      300, 255, 'claude-code',
      {
        ...cc('reviewer'),
        prompt: 'Using the reproduction report from the previous step, dig to the root cause.\n\n**The 5 Whys approach:** Ask "why did this happen?" repeatedly until you reach the true origin.\n\n**PHASE 1 — TRACE THE FAILURE CHAIN**\nStarting from the point of failure identified in the reproduction step, trace backward:\n- Why does this code do the wrong thing?\n- What data or state is it operating on that causes the wrong behavior?\n- Where does that incorrect data or state come from?\n- Continue until you reach the original source of the error\n\n**PHASE 2 — CLASSIFY THE ROOT CAUSE**\nIs this:\n- A logic error in a specific function?\n- Missing null/undefined handling?\n- A race condition or timing issue?\n- Incorrect assumptions about the data shape?\n- Missing validation at a system boundary?\n- A state management bug?\n- A misunderstood API contract?\n- A regression introduced by a recent change? (check git blame if relevant)\n\n**PHASE 3 — CONFIRM THE ROOT CAUSE**\nVerify your hypothesis by tracing it forward: if the root cause is what you identified, does that explanation fully account for the symptoms described in the bug report?\n\n**OUTPUT**\n```\n## Root Cause Analysis\n\n### The 5 Whys Chain\n1. **Why** did [symptom] occur? → Because [reason 1]\n2. **Why** [reason 1]? → Because [reason 2]\n3. **Why** [reason 2]? → Because [reason 3]\n[continue until root]\n\n### Root Cause\n**Classification:** [type from phase 2]\n**Location:** [file:line]\n**Description:** [precise explanation of the original cause]\n\n### Confidence\n[HIGH / MEDIUM / LOW — and why]\n\n### Confirmation\n[Does this root cause fully explain the observed symptoms? How?]\n```',
      }, [s1]);

    step(wfId, s3, 'Impact Assessment',
      'Determine how many users are affected, what data is at risk, and whether related bugs exist.',
      300, 430, 'claude-code',
      {
        ...cc('reviewer'),
        prompt: 'Assess the full impact of this bug before designing a fix.\n\n**PHASE 1 — USER IMPACT**\n- Who is affected? (all users / specific roles / specific conditions)\n- How frequently does this occur? (every request / daily / rare edge case)\n- What is the user experience impact? (broken feature / wrong data / data loss / security issue)\n- Is there a workaround users can use?\n\n**PHASE 2 — DATA IMPACT**\n- Has incorrect data been written to the database?\n- Is any user data at risk of being lost or corrupted?\n- Does this bug affect historical records or only new operations?\n- Is a data migration or cleanup needed as part of the fix?\n\n**PHASE 3 — RELATED BUGS**\nUsing the root cause identified, grep for similar patterns in the codebase:\n- Are there other places where the same mistake was made?\n- Are there related code paths that have the same vulnerability?\n- Are there similar functions that should be checked for the same issue?\n\n**PHASE 4 — SEVERITY CLASSIFICATION**\nClassify overall severity:\n- **Critical**: data loss, security breach, complete feature outage for all users\n- **High**: incorrect behavior on the happy path for many users\n- **Medium**: edge case failure, usually with a workaround\n- **Low**: cosmetic or very rare condition\n\n```\n## Impact Assessment\n\n### User Impact\n- **Affected users:** [all / specific segment / edge case]\n- **Frequency:** [every time / often / rarely]\n- **UX impact:** [description]\n- **Workaround:** [exists / none]\n\n### Data Impact\n- **Data at risk:** [YES — description / NO]\n- **Cleanup needed:** [YES — description / NO]\n\n### Related Bugs Found\n| File:Line | Issue | Severity |\n|-----------|-------|----------|\n[rows if any related bugs found]\n\n### Overall Severity: [critical / high / medium / low]\n### Priority: [fix immediately / fix in next release / backlog]\n```',
      }, [s2]);

    step(wfId, s4, 'Fix Plan',
      'Design the minimal correct fix. Requires human review before any code is changed.',
      300, 605, 'claude-code',
      {
        ...cc('planner'),
        prompt: 'Using the root cause and impact assessment, design the fix. Keep it minimal — fix the root cause, not just the symptom.\n\n**Principles for a good bug fix:**\n1. Fix the root cause, not the symptom\n2. Make the minimal change that resolves the issue — do not refactor or improve surrounding code in the same commit\n3. The fix should be understandable to someone reading it without the bug report context\n4. Consider: could the fix break anything else?\n\n**OUTPUT**\n```\n## Fix Plan\n\n### The Fix\n**File:** [path]\n**Line(s):** [line range]\n**Change:** [describe the exact change in one sentence]\n\n### Why This Fix Works\n[How the change addresses the root cause — not just the symptom]\n\n### Code Sketch\n```[language]\n// BEFORE:\n[current code]\n\n// AFTER:\n[proposed code]\n```\n\n### What Could Break\n[Any other code paths that rely on the current (buggy) behavior]\n[Tests that may need updating]\n\n### Data Cleanup (if needed)\n[SQL or script to fix any corrupted data]\n\n### Tests to Add\n[New test cases that would have caught this bug]\n\n### Related Fixes\n[The related bugs found in impact assessment — should they be fixed in the same PR or separately?]\n```\n\n⚠️ This step has manual advance — human review required before implementation.',
      }, [s3], false);

    step(wfId, s5, 'Implement Fix',
      'Apply the fix exactly as planned. No refactoring beyond the fix scope.',
      300, 780, 'claude-code',
      {
        ...cc('backend'),
        prompt: 'Implement the fix from the Fix Plan. Follow the plan precisely — do not make changes beyond the defined scope.\n\n**Rules:**\n1. Implement exactly what is in the Fix Plan — no more, no less\n2. If you discover the fix plan is wrong or incomplete, STOP and explain why rather than improvising\n3. Do not fix other issues you notice — log them but do not change them\n4. Add the test cases specified in the Fix Plan\n5. Do not reformat or restyle code you are not fixing\n\n**For each change made:**\n```\nCHANGED [file:line] — [brief description of what changed]\n```\n\n**For any issues noticed but NOT fixed:**\n```\nNOTED (not fixed) [file:line] — [brief description]\n```\n\n**Summary output:**\n```\n## Fix Applied\n\n### Changes Made\n[list of CHANGED lines]\n\n### Tests Added\n[list of new tests]\n\n### Scope Boundary\n[Confirm: "All changes are within the scope defined by the Fix Plan. No other changes were made."]\n```',
      }, [s4]);

    step(wfId, s6, 'Verify Fix',
      'Run the full test suite and confirm the bug no longer reproduces.',
      300, 955, 'quality-gate',
      { ...gate('test'), routingRules: [{ id: randomUUID(), condition: 'contains', value: 'STATUS: FAIL', nextStepId: s5 }], maxCycles: 2 }, [s5]);

    step(wfId, s7, 'Capture Learnings',
      'Save bug root cause and fix pattern to project learnings.',
      300, 1130, 'connector',
      { connectorType: 'capture-learnings', includeDepOutput: true }, [s6]);
  }

  // ── 14. Code Review & Audit ───────────────────────────────────────────────
  {
    const wfId = randomUUID();
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(), s5 = randomUUID(), s6 = randomUUID();
    insertWorkflow.run(wfId, 'Code Review & Audit',
      'Set the workflow description to the branch, PR, or files to review. Deep code reading → logic review → security audit → test coverage → review report (human gate) → capture learnings.', now);

    step(wfId, s1, 'Code Reading',
      'Understand every change end-to-end before evaluating anything. No judgments yet.',
      300, 80, 'claude-code',
      {
        ...cc('reviewer'), workflowContext: true,
        prompt: 'The branch, PR, or code to review is described above. Before forming any opinions, deeply understand what the code does.\n\n**PHASE 1 — IDENTIFY THE CHANGES**\nUse Bash to run `git diff main...HEAD` (or the relevant branch comparison) to see what changed, or use Grep/Glob/Read to find the files described.\n\n**PHASE 2 — READ EVERY CHANGED FILE**\nFor each changed file:\n1. Read the full file (not just the diff)\n2. Understand its role in the system\n3. Trace how it connects to other files\n4. Follow the data flow through the changed code\n\n**PHASE 3 — BUILD A MENTAL MODEL**\nAfter reading all changes, describe:\n- What the code does (the intent)\n- How it does it (the mechanism)\n- What it depends on (inputs, state, external calls)\n- What it produces (outputs, side effects)\n\n**OUTPUT**\n```\n## Code Reading Summary\n\n### Files Changed\n| File | Change Type | Lines Changed | Role |\n|------|-------------|---------------|------|\n[one row per file — Change Type: new/modified/deleted]\n\n### What This Code Does\n[2-4 sentences: the intent and mechanism in plain English]\n\n### Data Flow\n[How data enters → is transformed → exits through the changed code]\n\n### Dependencies\n[What this code depends on that could be affected by bugs here]\n\n### First Impressions\n[No judgments yet — just: is this more complex than expected, simpler, surprising in any way?]\n```',
      }, []);

    step(wfId, s2, 'Logic Review',
      'Find logic errors, incorrect assumptions, missing edge cases, and code that could fail under real conditions.',
      300, 255, 'claude-code',
      {
        ...cc('reviewer'),
        prompt: 'Now that you understand the code, evaluate its correctness. Look for bugs, not style issues.\n\n**What to check:**\n\n**Logic Correctness**\n- Does the code do what its author intended?\n- Are there conditions where the logic produces the wrong result?\n- Are boolean conditions correct? (AND vs OR, negation errors)\n- Are comparison operators correct? (< vs <=, type coercion in ==)\n\n**Edge Cases**\n- What happens with empty arrays or empty strings?\n- What happens with null/undefined inputs?\n- What happens when the value is at the boundary (0, -1, MAX_INT)?\n- What happens when the list has exactly 1 item?\n\n**Async Correctness**\n- Are all promises awaited?\n- Could a state update happen after a component unmounts?\n- Could two concurrent calls produce a race condition?\n- Are side effects triggered in the right order?\n\n**State Mutations**\n- Is any shared state mutated without proper synchronization?\n- Are objects or arrays mutated directly instead of creating new ones?\n- Could a reference escape its intended scope?\n\n**Error Handling**\n- What happens when an API call fails?\n- Are errors propagated correctly or silently swallowed?\n- Does the code recover to a usable state after an error?\n\n**OUTPUT**\n```\n## Logic Review\n\n| Severity | File:Line | Issue | Impact |\n|----------|-----------|-------|--------|\n[one row per issue — Severity: critical/high/medium/low/nitpick]\n\n### Detailed Issues\n#### [Issue 1 — Title]\n**File:Line:** [path:line]\n**Severity:** [level]\n**Issue:** [what is wrong]\n**Impact:** [what breaks if this is not fixed]\n**Suggested Fix:** [concrete fix]\n\n[repeat for each medium+ severity issue]\n\nTotal issues: N | Critical: N | High: N | Medium: N | Low/Nitpick: N\n```',
      }, [s1]);

    step(wfId, s3, 'Security Audit',
      'Check for injection vulnerabilities, auth gaps, data exposure, and OWASP Top 10 issues in the changed code.',
      300, 430, 'quality-gate',
      gate('security'), [s2]);

    step(wfId, s4, 'Test Coverage Check',
      'Evaluate whether the changed code is adequately tested. Identify missing test cases.',
      300, 605, 'claude-code',
      {
        ...cc('tester'),
        prompt: 'Evaluate the test coverage for the code changes under review.\n\n**PHASE 1 — FIND EXISTING TESTS**\nSearch for test files related to the changed code (same module, same component, same API route). Read them.\n\n**PHASE 2 — MAP COVERAGE**\nFor each function, branch, or behavior in the changed code, determine:\n- Is there a test that exercises this code path?\n- Does the test assert the correct behavior (not just that the function runs)?\n- Are edge cases tested (empty input, error states, boundary values)?\n\n**PHASE 3 — IDENTIFY GAPS**\nList every behavior in the changed code that is not covered by existing tests.\n\n**PHASE 4 — WRITE MISSING TESTS (optional but recommended)**\nIf significant gaps exist, write the missing tests. Prefer writing tests over just reporting gaps.\n\n**OUTPUT**\n```\n## Test Coverage Report\n\n### Coverage Map\n| Function/Behavior | Test File | Test Name | Status |\n|-------------------|-----------|-----------|--------|\n[one row per testable behavior — Status: ✅ Covered / ⚠️ Partial / ❌ Not covered]\n\n### Missing Tests\n| Behavior | Why It Matters | Suggested Test |\n|----------|----------------|----------------|\n[one row per gap]\n\n### Tests Written (if any)\n[List new test files/functions written]\n\n### Coverage Score: N/10\n[Brief rationale for the score]\n```',
      }, [s3]);

    step(wfId, s5, 'Review Report',
      'Compile the full code review with verdict and action items. Requires human review and approval.',
      300, 780, 'claude-code',
      {
        ...cc('planner'),
        prompt: 'Compile the complete code review report. Be direct — give a clear verdict.\n\n```\n## Code Review Report\n\n### Summary\n[2-3 sentences: overall quality of the changes, main strengths, main concerns]\n\n### Verdict\n**[APPROVE / APPROVE WITH CHANGES / REQUEST CHANGES / REJECT]**\n[One sentence rationale]\n\n---\n\n### All Issues\n| ID | Severity | Category | File:Line | Issue |\n|----|----------|----------|-----------|-------|\n| CR-001 | critical | logic | [path:line] | [description] |\n[one row per issue found across all review steps]\n\n---\n\n### Blocking Issues (must fix before merge)\n[Bulleted list with specific file:line and exact change required]\n\n### Recommendations (should fix)\n[Bulleted list]\n\n### Minor Comments (can fix or explain)\n[Bulleted list]\n\n---\n\n### What Works Well\n[2-3 specific things done well — be specific, not generic]\n\n---\n\n### Checklist\n- [ ] Logic correct: [YES / NO — N issues]\n- [ ] Security: [CLEAN / N issues]\n- [ ] Tests adequate: [YES / PARTIAL / NO — score N/10]\n- [ ] Error handling complete: [YES / PARTIAL / NO]\n- [ ] No breaking changes: [YES / NO — describe if NO]\n```',
      }, [s4], false);

    step(wfId, s6, 'Capture Learnings',
      'Save review findings and code quality patterns to project learnings.',
      300, 955, 'connector',
      { connectorType: 'capture-learnings', includeDepOutput: true }, [s5]);
  }

  // ══════════════════════════════════════════════════════════════════════
  // COMPOUND ENGINEERING × GSTACK — 7-phase feature delivery templates
  // Launch context: enter the feature slug (e.g. "user-auth-v2") so
  // every step can read/write to docs/[slug]/ and todos/[slug]/.
  // ══════════════════════════════════════════════════════════════════════

  // ── CE Phase 1 — Interrogate ─────────────────────────────────────────
  {
    const wfId = randomUUID();
    const s1 = randomUUID(), s2 = randomUUID(), s2b = randomUUID(), s3 = randomUUID(), s4 = randomUUID(), s5 = randomUUID();
    insertWorkflow.run(wfId, 'CE: Phase 1 — Interrogate',
      'Challenge the idea before any planning begins. Enter the feature slug + description in launch context. Outputs docs/[slug]/brainstorm.md.', now);

    step(wfId, s1, 'Load Prior Work',
      'Search CLAUDE.md and docs/solutions/ for existing patterns and prior decisions related to this feature.',
      300, 80, 'claude-code',
      { ...cc('researcher'), workflowContext: true, prompt: 'The feature name/slug is in the workflow context above.\n\n1. READ CLAUDE.md — extract patterns, anti-patterns, taste decisions, and caveats relevant to this feature area.\n2. SEARCH docs/solutions/ for any compound docs related to this domain. Read any relevant ones.\n3. SEARCH docs/brainstorms/ and docs/plans/ for any prior work on this feature.\n\nOutput a Prior Work Summary:\n```\n## Prior Work Summary\n\n### CLAUDE.md Relevant Notes\n[bullet list — or "None"]\n\n### Prior Compound Docs Found\n[names and 1-sentence summary each — or "None"]\n\n### Prior Brainstorms / Plans Found\n[names and key decisions — or "None"]\n\n### Verdict\n[CLEAN START — no relevant prior work] or [PRIOR WORK EXISTS — key context: ...]\n```' }, []);

    step(wfId, s2, 'Office Hours — Interrogate',
      'Run /office-hours: 6 forcing questions to challenge the idea, surface assumptions, and generate 2–3 approaches with effort estimates.',
      300, 255, 'claude-code',
      { ...cc('planner'), prompt: 'You are running /office-hours. Prior work findings are above.\n\nAsk 6 forcing questions — answer each based on the feature context:\n\n**Q1 — DEMAND REALITY**: Who specifically wants this? How do we know?\n**Q2 — STATUS QUO**: What are users doing right now without this? Why is that not enough?\n**Q3 — DESPERATE SPECIFICITY**: Describe the one person most desperate for this. What is their exact situation?\n**Q4 — NARROWEST WEDGE**: What is the smallest version that still delivers real value?\n**Q5 — OBSERVATION**: Have we watched someone try to do this? What actually happened?\n**Q6 — FUTURE FIT**: In 2 years, does this feature become more or less relevant? Why?\n\nThen generate 2–3 implementation approaches:\nFor each: name, one-sentence description, effort (S/M/L), key assumption, biggest risk.\n\nEnd with:\n```\n## Recommended Approach\n[name]: [why]\n\n## Key Assumptions\n- [list]\n\n## Estimated Effort: [S/M/L]\n```' }, [s1]);

    step(wfId, s2b, 'Pick Approach',
      'Human decision: choose which implementation approach from Office Hours to carry into the brainstorm and plan.',
      300, 430, 'decision',
      {
        question: 'Which implementation approach should we pursue?',
        eli10: 'Office Hours just explored 2–3 ways to build this. Pick one — it shapes the entire plan. Read the step output above before choosing.',
        stakes: 'This choice locks the architecture for the sprint. Switching approaches mid-build is expensive.',
        recommendation: 'approach-recommended',
        options: [
          { id: 'approach-recommended', label: 'Recommended approach', description: 'Pursue the approach Office Hours flagged as recommended. Details in the output above.' },
          { id: 'approach-alternative', label: 'Alternative approach', description: 'Use one of the non-recommended alternatives. Specify which in the CE Brainstorm step.' },
          { id: 'approach-minimal', label: 'Narrowest wedge only', description: 'Build the absolute minimum version — fastest to ship but least complete.' },
        ],
      }, [s2]);

    step(wfId, s3, 'CE Brainstorm',
      'Run CE /ce-brainstorm: lightweight repo research, clarify purpose/users/constraints, define what "done" looks like.',
      300, 605, 'claude-code',
      { ...cc('researcher'), prompt: 'You are running CE /ce-brainstorm. The chosen approach (from the decision step above) and Office Hours output are in context — build on them, do not repeat.\n\n1. REPO RESEARCH — use Read, Grep, Glob:\n   - Find existing code related to this feature\n   - Identify files and modules that will be touched\n   - Note established patterns you must follow\n   - Flag constraints (locked interfaces, technical debt)\n\n2. CLARIFY (for the CHOSEN approach only):\n   - Purpose (what does this solve at the code level?)\n   - Users (which flows are affected?)\n   - Hard constraints (what must NOT change?)\n   - Top 3 edge cases\n\n3. DEFINE DONE — concrete, observable criteria.\n\nOutput:\n```\n## CE Brainstorm\n\n### Chosen Approach\n[restate the chosen approach from the decision step]\n\n### Repo Research\n[files affected, patterns to follow, constraints]\n\n### Clarified Purpose\n[one paragraph]\n\n### Users & Flows Affected\n[bullet list]\n\n### Top Edge Cases\n1. [case + handling]\n2. [case + handling]\n3. [case + handling]\n\n### Definition of Done\n- [ ] [criterion]\n- [ ] [criterion]\n```' }, [s2b]);

    step(wfId, s4, 'Write Brainstorm Doc',
      'Merge all outputs into docs/[slug]/brainstorm.md. Pauses for human review before Phase 2 begins.',
      300, 780, 'claude-code',
      { ...cc('planner'), prompt: 'Merge all prior step outputs into a canonical brainstorm document.\n\n1. Determine the feature slug from context (lowercase-hyphenated, e.g. "user-auth-v2").\n2. Create docs/[slug]/ directory if needed.\n3. WRITE docs/[slug]/brainstorm.md:\n   - ## Problem Statement\n   - ## Chosen Approach (from decision step — one sentence)\n   - ## Approaches Considered (table: name | effort | key assumption | risk)\n   - ## Scoped Definition (in / out)\n   - ## Files / Modules Affected\n   - ## Constraints\n   - ## Top Edge Cases\n   - ## Definition of Done (checklist)\n   - ## Open Questions\n   - ## Prior Work References\n   - ## Effort Estimate: [S/M/L]\n\n4. Output gate summary:\n```\n## Phase 1 — AWAITING HUMAN REVIEW\n\nFeature: [name] | Slug: [slug]\nChosen approach: [one sentence]\nKey assumptions: [bullet list]\nEstimated effort: [S/M/L]\nFile written: docs/[slug]/brainstorm.md\n\nAdvance manually after reviewing the brainstorm doc.\n```\n\nDo NOT advance automatically.', }, [s3], false);

    step(wfId, s5, 'Phase 1 Complete',
      'Phase 1 — Interrogate complete. Brainstorm doc is ready for review.',
      300, 955, 'connector',
      { connectorType: 'system-notify', title: 'CE Phase 1 — Interrogate Done', message: 'Brainstorm doc ready. Review docs/[slug]/brainstorm.md then advance to Phase 2.' }, [s4]);
  }

  // ── CE Phase 2 — Plan ─────────────────────────────────────────────────
  {
    const wfId = randomUUID();
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(), s5 = randomUUID(), s6 = randomUUID();
    insertWorkflow.run(wfId, 'CE: Phase 2 — Plan',
      'Pressure-test the plan from 3 angles before any code is written. Load brainstorm → CEO + Eng + CE Plan run in parallel → merge to docs/[slug]/plan.md.', now);

    step(wfId, s1, 'Load Brainstorm',
      'Read docs/[slug]/brainstorm.md and prepare a structured summary for the three parallel review agents.',
      450, 80, 'claude-code',
      { ...cc('researcher'), workflowContext: true, prompt: 'The feature slug is in workflow context above.\n\nREAD docs/[slug]/brainstorm.md in full.\n\nOutput a structured summary:\n```\n## Brainstorm Summary for Plan Review\n\nFeature: [name] | Slug: [slug]\nRecommended Approach: [one sentence]\nEffort: [S/M/L]\n\n### Files / Modules Affected\n[list]\n\n### Key Constraints\n[list]\n\n### Open Questions from Phase 1\n[list]\n\n### Definition of Done\n[checklist]\n```\n\nThis feeds three parallel reviews (CEO, Engineering, CE Research) that run simultaneously.' }, []);

    step(wfId, s2, '/plan-ceo-review',
      'Scope check, 10-star product test, 4 scope modes. Runs in parallel with Eng Review and CE Plan Research.',
      150, 255, 'claude-code',
      { ...cc('planner'), prompt: 'You are running /plan-ceo-review. Brainstorm summary is above.\n\nPick ONE of 4 scope modes and argue it:\n- EXPANSION: should we build MORE? What value are we leaving on the table?\n- SELECTIVE EXPANSION: core + one high-value addition. What is the addition?\n- HOLD SCOPE: the proposal is right as stated. Defend it.\n- REDUCTION: we are overbuilding. What is the minimum that still delivers real value?\n\nRun the 10-star product test:\n- 7/10 version (mediocre but ships): [description]\n- 10/10 version (legendary, 10x longer): [description]\n- Recommended target: [N/10] — [why]\n\nOutput:\n```\n## CEO Review\n\n### Mode: [NAME]\n[3-4 sentence argument]\n\n### 10-Star Test\n7/10: [description]\n10/10: [description]\nTarget: [N/10] — [why]\n\n### Scope Recommendation\nIn: [list] | Out: [list]\n\n### Risk Flags\n- [flag]\n- [flag]\n```' }, [s1]);

    step(wfId, s3, '/plan-eng-review',
      'Architecture, data flow diagram, edge cases, test matrix, security concerns. Runs in parallel.',
      450, 255, 'claude-code',
      { ...cc('architect'), prompt: 'You are running /plan-eng-review. Brainstorm summary is above.\n\n1. DATA FLOW — draw ASCII diagram: User action → [layers] → DB/API → response → UI state\n\n2. AFFECTED FILES — table: File | Change Type | Why\n\n3. KEY INTERFACES — types/interfaces to create or modify\n\n4. EDGE CASES — top 5: Case | Input | Expected behavior | Failure mode\n\n5. TEST MATRIX — minimum test coverage: Test | Type (unit/integration/e2e) | What it verifies\n\n6. FAILURE MODES — what breaks in production if this fails?\n\n7. SECURITY CONCERNS — auth, authorization, input validation, data exposure at design level\n\nOutput all sections clearly labeled.' }, [s1]);

    step(wfId, s4, 'CE Plan Research',
      'Spawn repo research, framework docs, and best practices research simultaneously. Runs in parallel.',
      750, 255, 'claude-code',
      { ...cc('researcher'), prompt: 'You are running CE /ce-plan research. Brainstorm summary is above.\n\nRun three parallel research tracks:\n\n**TRACK 1 — REPO PATTERNS** (repo-research-analyst):\nSearch codebase for: existing patterns for this feature type, prior similar implementations, naming/file/test conventions. Use Read, Grep, Glob extensively.\n\n**TRACK 2 — FRAMEWORK DOCS** (framework-docs-researcher):\nIdentify frameworks/libraries this feature uses. For each: official approach, version constraints, recommended patterns.\n\n**TRACK 3 — BEST PRACTICES** (best-practices-researcher):\nIndustry-standard approaches, what senior engineers get wrong on this type of feature, security/performance best practices.\n\nSynthesize into:\n```\n## CE Plan Research\n\n### Existing Codebase Patterns\n[what to follow, what already exists]\n\n### Framework Guidance\n[official approach + version constraints]\n\n### Industry Best Practices\n[key patterns + pitfalls to avoid]\n\n### Implementation Recommendations\n- [specific recommendation]\n- [specific recommendation]\n- [specific recommendation]\n```' }, [s1]);

    step(wfId, s5, 'Write Plan Doc',
      'Merge CEO review, Eng review, and CE research into docs/[slug]/plan.md. Pauses for human review.',
      450, 430, 'claude-code',
      { ...cc('planner'), prompt: 'Merge all three parallel review outputs into a canonical plan document.\n\nWRITE docs/[slug]/plan.md:\n- ## Overview (what, why, how — one paragraph)\n- ## Scope (in / out — from CEO review)\n- ## Architecture (data flow ASCII + interfaces — from Eng review)\n- ## Affected Files (table: file | change type | why)\n- ## Implementation Steps (numbered, ordered, each step is one actionable task)\n- ## Test Plan (table: test | type | what it verifies)\n- ## Security Checklist (from Eng review)\n- ## Rollback Plan (how to revert if something goes wrong)\n- ## Open Decisions (items still requiring human input)\n\nOutput gate summary:\n```\n## Phase 2 — AWAITING HUMAN REVIEW\n\nFeature: [name] | Slug: [slug]\nAffected files: [count]\nImplementation steps: [count]\nRisks identified:\n- [risk]\nOpen decisions:\n- [decision]\nFile written: docs/[slug]/plan.md\n\nAdvance manually after reviewing the plan doc.\n```\n\nDo NOT advance automatically.', }, [s2, s3, s4], false);

    step(wfId, s6, 'Phase 2 Complete',
      'Phase 2 — Plan complete. Plan doc is ready for review.',
      450, 605, 'connector',
      { connectorType: 'system-notify', title: 'CE Phase 2 — Plan Done', message: 'Plan ready. Review docs/[slug]/plan.md then advance to Phase 3.' }, [s5]);
  }

  // ── CE Phase 3 — Implement ────────────────────────────────────────────
  {
    const wfId = randomUUID();
    const s1 = randomUUID(), s1b = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(), s5 = randomUUID();
    insertWorkflow.run(wfId, 'CE: Phase 3 — Implement',
      'Isolated implementation in a git worktree. Load plan → write failing tests (TDD) → implement → run tests → build summary. Auto-continues to Phase 4.', now);

    step(wfId, s1, 'Load Plan + Worktree',
      'Read docs/[slug]/plan.md, create isolated git worktree on feature branch, and output a step checklist.',
      300, 80, 'claude-code',
      { ...cc('architect'), workflowContext: true, prompt: 'The feature slug is in workflow context above.\n\n1. READ docs/[slug]/plan.md in full.\n2. Create an isolated git worktree:\n   git worktree add ../[slug]-work feature/[slug]\n   If it already exists, verify it is on the correct branch.\n3. Safety mode: before any destructive operation (file deletion, DROP TABLE, force-push), state what you are about to do and confirm via the plan.\n\nOutput:\n```\n## Phase 3 Setup\n\nFeature: [name] | Slug: [slug]\nWorktree: ../[slug]-work\nBranch: feature/[slug]\nPlan loaded: [N] implementation steps\n\n### Step Checklist\n[ ] Step 1: [name]\n[ ] Step 2: [name]\n[all steps from plan]\n```' }, []);

    step(wfId, s1b, 'Write Failing Tests',
      'TDD: write real failing tests for every item in the plan\'s test matrix before any implementation code exists. Commit the test files.',
      300, 255, 'claude-code',
      { ...cc('tester'), prompt: 'Read the Test Plan section from docs/[slug]/plan.md. Write real, runnable tests for every item in that plan — before any implementation code exists.\n\n### PHASE 1 — FIND TEST CONVENTIONS\n1. Search the project for existing test files: `*.test.ts`, `*.spec.ts`, `*.test.tsx`, `__tests__/`, `test/`, `spec/`.\n2. Read 2-3 representative test files to understand: framework (Jest, Vitest, etc.), assertion style, mock patterns, file naming, and import conventions.\n\n### PHASE 2 — WRITE FAILING TESTS\nFor each row in the Test Plan table from docs/[slug]/plan.md:\n1. Write a real test using the project\'s framework and conventions.\n2. Each test must cover: happy path + at least 2 edge cases + at least 1 error state per requirement.\n3. Place each test in the correct file — extend an existing test file or create a new one following project conventions.\n4. Do NOT write implementation code. Import the functions/modules by their final intended path — they may not exist yet, and that is expected.\n\n### PHASE 3 — CONFIRM THEY FAIL\nRun the test suite (or just the new test files) and confirm that every new test FAILS.\n- If a test passes before any implementation: the test is wrong — rewrite it so it actually verifies the behavior.\n- If a test fails with "module not found": that is acceptable — the implementation file does not exist yet.\n\n### OUTPUT\n```\n## TDD Test Manifest\n\n### Tests Written\n| File | Test Name | Plan Row | Status |\n|------|-----------|----------|--------|\n[one row per test — Status must be FAIL or MODULE NOT FOUND]\n\n### Test Run Output\n[paste relevant test runner output]\n\n### Summary\nTests written: N | All failing: [YES / NO — if NO, list the ones that incorrectly pass]\n```\n\nCommit the test files: "test: [slug] — write failing TDD tests for Phase 3"' }, [s1]);

    step(wfId, s2, 'CE Implement',
      'Execute every step in the plan sequentially. WIP commits after each step. Adapt and document any deviations.',
      300, 430, 'claude-code',
      { ...cc('backend'), prompt: 'You are running CE /ce-work. Plan, worktree setup, and failing tests are above.\n\nRules:\n1. Execute implementation steps IN ORDER from the plan. Do not skip.\n2. After each file changed: run the relevant linter/type-checker for that file.\n3. After each step: WIP commit — format: "WIP: [slug] — step N: [name]"\n4. If a step reveals a problem with the plan: adapt, implement the better approach, and document the deviation.\n5. Do NOT modify the test files written in the previous step — make the implementation satisfy them.\n6. Do NOT open a PR.\n\nOutput after all steps:\n```\n## Implementation Complete\n\n### Steps Executed\n[numbered list — each: ✅ done or ⚠️ DEVIATED: [what changed and why]]\n\n### Files Changed\n[list]\n\n### Deviations from Plan\n[list — or "None"]\n```' }, [s1b]);

    step(wfId, s3, 'Run Tests',
      'Execute full test suite. Routes back to CE Implement if any tests fail (max 3 cycles).',
      300, 605, 'quality-gate',
      { ...gate('test'), routingRules: [{ id: randomUUID(), condition: 'contains', value: 'STATUS: FAIL', nextStepId: s2 }], maxCycles: 3 }, [s2]);

    step(wfId, s4, 'Build Summary',
      'Run type check, lint, and coverage check. Write todos/[slug]/build-summary.md. Auto-continues to Phase 4.',
      300, 780, 'claude-code',
      { ...cc('reviewer'), prompt: 'Run full pre-merge verification. Do NOT open a PR.\n\n1. TYPE CHECK: run tsc --noEmit (or equivalent). Report: clean / N errors.\n2. LINT: run the linter. Report: clean / N issues.\n3. COVERAGE: check test coverage. Report: N%. Flag if below project threshold.\n\nWRITE todos/[slug]/build-summary.md with:\n- Tests: [N passing / N failing]\n- Type check: [clean / N errors]\n- Lint: [clean / N issues]\n- Coverage: [N%]\n- Files changed: [list]\n- Deviations from plan: [list or "None"]\n\nOutput:\n```\nSTATUS: [PASS — ready for Phase 4] | [FAIL — resolve before continuing]\n\n[If FAIL: list each blocking issue with file:line]\n```' }, [s3]);

    step(wfId, s5, 'Phase 3 Complete',
      'Phase 3 — Implement complete. Auto-advancing to Phase 4.',
      300, 955, 'connector',
      { connectorType: 'system-notify', title: 'CE Phase 3 — Implement Done', message: 'Build complete. Review build summary then start Phase 4 — Review.' }, [s4]);
  }

  // ── CE Phase 4 — Review ───────────────────────────────────────────────
  {
    const wfId = randomUUID();
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(), s5 = randomUUID(), s6 = randomUUID(), s7 = randomUUID(), s8 = randomUUID(), s8b = randomUUID(), s9 = randomUUID(), s10 = randomUUID(), s11 = randomUUID();
    insertWorkflow.run(wfId, 'CE: Phase 4 — Review',
      '6 specialist agents run in parallel (security, perf, architecture, quality, codex) → triage P1/P2/P3 → decision checkpoint → resolve P2s → open PR.', now);

    step(wfId, s1, 'Load Diff + Build Summary',
      'Read the feature plan and current git diff. Prepare review dispatch context for all parallel agents.',
      650, 80, 'claude-code',
      { ...cc('reviewer'), workflowContext: true, prompt: 'The feature slug is in workflow context above.\n\n1. READ docs/[slug]/plan.md\n2. READ todos/[slug]/build-summary.md\n3. Run: git diff main...HEAD to get the full diff.\n\nOutput structured dispatch context:\n```\n## Review Dispatch Context\n\nFeature: [name] | Slug: [slug]\nBranch: feature/[slug]\nFiles changed: [count] — [list]\nTests: [passing/failing]\nCoverage: [N%]\n\n### Diff Summary\n[brief description of what changed, organized by file]\n\n### Plan Reference\ndocs/[slug]/plan.md\n```\n\nThis feeds 6 parallel specialist review agents.' }, []);

    step(wfId, s2, 'Security Sentinel',
      'CE security-sentinel: OWASP Top 10, injection, auth flaws, authorization bypasses. Runs in parallel.',
      100, 255, 'claude-code',
      { ...cc('reviewer'), prompt: 'You are CE security-sentinel. Diff and context are above.\n\nAudit for OWASP Top 10:\n1. Injection (SQL, command, XSS, template)\n2. Broken authentication / session management\n3. Sensitive data exposure\n4. Broken access control / missing authorization checks\n5. Security misconfiguration\n6. Insecure deserialization\n7. Missing input validation / sanitization on user-controlled values\n8. Hardcoded credentials or API keys\n9. Verbose error messages that leak internals\n10. Missing HTTPS or insecure transport\n\nFor each finding: file:line | vulnerability type | severity (critical/high/medium) | description | fix\n\nEnd with: SECURITY: CLEAN or SECURITY: N FINDINGS (critical: X, high: Y, medium: Z)' }, [s1]);

    step(wfId, s3, 'CSO / STRIDE Review',
      '/cso: OWASP + STRIDE threat model, 8/10+ confidence gate, verified findings only. Runs in parallel.',
      330, 255, 'claude-code',
      { ...cc('reviewer'), prompt: 'You are running /cso (Chief Security Officer review). Diff and context are above.\n\nRun a STRIDE threat model against this change:\n- SPOOFING: can an attacker impersonate another user or service?\n- TAMPERING: can data be modified without authorization?\n- REPUDIATION: can actions be denied? Is there an audit trail?\n- INFORMATION DISCLOSURE: can sensitive data leak?\n- DENIAL OF SERVICE: can this be abused to cause outages?\n- ELEVATION OF PRIVILEGE: can a lower-privilege user gain higher access?\n\nConfidence gate: only report findings with 8/10+ confidence. Exclude false positives.\n\nFor each finding: threat category | file:line | description | impact | recommended mitigation\n\nEnd with: CSO: APPROVED or CSO: N VERIFIED THREATS' }, [s1]);

    step(wfId, s4, 'Performance Oracle',
      'CE performance-oracle: N+1 queries, missing indexes, caching gaps, algorithmic bottlenecks. Runs in parallel.',
      560, 255, 'claude-code',
      { ...cc('reviewer'), prompt: 'You are CE performance-oracle. Diff and context are above.\n\nAnalyze for performance issues:\n1. N+1 QUERIES — loops that trigger per-iteration DB calls\n2. MISSING INDEXES — WHERE clauses on un-indexed columns\n3. FULL TABLE SCANS — queries without WHERE or with non-selective conditions\n4. MISSING CACHING — expensive operations that run on every request unnecessarily\n5. ALGORITHMIC COMPLEXITY — O(n²) or worse where O(n) or O(log n) is feasible\n6. BLOCKING OPERATIONS — sync calls in hot paths, missing pagination\n7. MEMORY LEAKS — objects retained in long-lived scope, event listeners not cleaned up\n8. UNNECESSARY RE-RENDERS — React/UI components re-rendering on every tick\n\nFor each finding: file:line | issue type | severity | description | suggested fix\n\nEnd with: PERFORMANCE: CLEAN or PERFORMANCE: N FINDINGS' }, [s1]);

    step(wfId, s5, 'Architecture Review',
      'CE architecture-strategist + pattern-recognition: system design, component boundaries, anti-patterns. Runs in parallel.',
      790, 255, 'claude-code',
      { ...cc('architect'), prompt: 'You are CE architecture-strategist and pattern-recognition-specialist combined. Diff and context are above.\n\nARCHITECTURE:\n1. Does this respect existing component boundaries and separation of concerns?\n2. Does data flow in the right direction? (no circular dependencies, no leaking internals)\n3. Does this create inappropriate coupling between modules?\n4. Does this belong at the right layer? (UI logic in UI, business logic in services, etc.)\n5. Will this scale? Any bottlenecks at the architectural level?\n\nPATTERNS:\n1. Does this follow the patterns already established in this codebase?\n2. Any anti-patterns: God objects, anemic models, magic numbers, shotgun surgery?\n3. Any code smells: duplicated logic, long functions, deep nesting, inconsistent naming?\n4. Any YAGNI violations: abstractions for hypothetical future requirements?\n\nFor each finding: file:line | category | severity | description | recommendation\n\nEnd with: ARCHITECTURE: CLEAN or ARCHITECTURE: N FINDINGS' }, [s1]);

    step(wfId, s6, 'Code Quality Review',
      'CE code-simplicity-reviewer + /review: production bugs that pass CI, completeness gaps, readability. Runs in parallel.',
      1020, 255, 'claude-code',
      { ...cc('reviewer'), prompt: 'You are CE code-simplicity-reviewer and staff-engineer reviewer combined. Diff and context are above.\n\nSIMPLICITY CHECK:\n1. Is there code that is more complex than it needs to be?\n2. Any premature abstractions — base classes, factories, registries for one use case?\n3. Any dead code introduced in this PR?\n4. Are variable/function names clear without needing comments?\n\nPRODUCTION READINESS (bugs that pass CI):\n1. Unhandled error states — what happens when this fails in production?\n2. Missing loading/empty states in UI\n3. Race conditions on concurrent requests\n4. Hard-coded values that should be config\n5. Missing logging for production debugging\n6. Incomplete feature — does the implementation fully satisfy the plan?\n\nFor each finding: file:line | category | severity | description | fix\n\nEnd with: QUALITY: CLEAN or QUALITY: N FINDINGS' }, [s1]);

    step(wfId, s7, 'Codex — Cross-Model Review',
      '/codex: independent review from a second model. Fresh eyes, no shared context with prior agents. Runs in parallel.',
      1250, 255, 'claude-code',
      { ...cc('reviewer'), prompt: 'You are running /codex — an independent cross-model review. You have NOT seen any prior review agent output.\n\nReview the diff and plan with completely fresh eyes:\n1. Read the diff carefully. Understand what it does.\n2. Read the plan. Does the implementation match the intent?\n3. Without being primed by other reviewers: what are the top 3 issues you notice?\n4. PASS/FAIL verdict: would you merge this into production as-is?\n\nOutput:\n```\n## Codex Review\n\n### Top Findings\n1. [file:line] SEVERITY: [level] — [description]\n2. [file:line] SEVERITY: [level] — [description]\n3. [file:line] SEVERITY: [level] — [description]\n\n### Implementation vs. Plan\n[Does the code do what the plan says? Any gaps?]\n\n### Verdict\nCODEX: [PASS | PASS WITH NOTES | FAIL]\n[one sentence rationale]\n```' }, [s1]);

    step(wfId, s8, 'Triage — P1 / P2 / P3',
      'Consolidate all 6 agent findings. Classify P1/P2/P3. Auto-resolve P3. Write todos/[slug]/p1.md and p2.md.',
      650, 430, 'claude-code',
      { ...cc('planner'), prompt: 'All 6 parallel review agent outputs are above. Consolidate and classify.\n\nClassification:\n- P1 — must fix before merge: security holes, data loss, broken core functionality, critical logic errors\n- P2 — should fix before merge: performance issues, architectural debt, incomplete error handling\n- P3 — nice to fix: style, naming, minor simplification → auto-resolve these now\n\nSteps:\n1. Deduplicate overlapping findings across agents.\n2. Classify every unique finding as P1, P2, or P3.\n3. AUTO-RESOLVE all P3 findings now (make the changes).\n4. WRITE todos/[slug]/p1.md — one finding per line: file:line | issue | severity | agent that found it\n5. WRITE todos/[slug]/p2.md — same format.\n\nOutput:\n```\n## Triage Complete\n\nP1 findings: [count] — [bullet list of each]\nP2 findings: [count] — [bullet list of each]\nP3 findings: [count] — auto-resolved\n\nFiles written:\n- todos/[slug]/p1.md ([count] items)\n- todos/[slug]/p2.md ([count] items)\n```' }, [s2, s3, s4, s5, s6, s7]);

    step(wfId, s8b, 'Review Decision',
      'Human decision: review triage results and choose how to proceed. Pick "Fix P1s" even if the list is empty — the next step handles it gracefully.',
      650, 605, 'decision',
      {
        question: 'Triage complete. How do you want to proceed?',
        eli10: 'The 6 review agents found issues, which are now classified. P3s were auto-fixed. P2s will be resolved next. P1s are blockers — read todos/[slug]/p1.md before choosing.',
        stakes: 'P1 findings include security holes, data loss risks, or broken functionality. Proceeding with known P1s is a deliberate risk decision.',
        recommendation: 'fix-p1s',
        options: [
          { id: 'fix-p1s', label: 'Fix P1s, then proceed', description: 'Address all P1 findings before opening the PR. The next step will fix them alongside P2s.' },
          { id: 'proceed-as-is', label: 'Accept risk and proceed', description: 'No blocking P1s, or they are confirmed false positives. Proceed directly to opening the PR.' },
          { id: 'abandon-pr', label: 'Abandon this PR', description: 'Findings are too severe. Close the branch and re-plan from Phase 2.' },
        ],
      }, [s8]);

    step(wfId, s9, 'Resolve P1s + P2s',
      'Fix all P1 findings (if any) and all P2 findings from the triage. Each fix gets its own focused commit.',
      650, 780, 'claude-code',
      { ...cc('backend'), prompt: 'The review decision and triage results are above.\n\nIf the human chose "Fix P1s, then proceed":\n1. READ todos/[slug]/p1.md — fix every P1 first, in priority order.\n2. Commit each fix: "fix: [slug] P1 — [description]"\n\nIf the human chose "Accept risk and proceed":\n1. Skip P1 fixes — they are accepted as-is.\n\nThen fix ALL P2 findings regardless of the P1 decision:\n1. READ todos/[slug]/p2.md\n2. Fix each P2 with a focused commit: "fix: [slug] P2 — [description]"\n\nDo not introduce new logic beyond the fixes.\n\nOutput:\n```\n## Resolutions\n\nP1s fixed: [count] | [list]\nP2s fixed: [count] | [list]\n```' }, [s8b]);

    step(wfId, s10, 'Open PR',
      'Squash WIP commits and run /ship to open the PR. Human reviews before merge.',
      650, 955, 'claude-code',
      { ...cc('planner'), prompt: 'Open the PR for this feature.\n\n1. Squash WIP commits: git rebase -i to collapse all "WIP:" prefixed commits.\n2. Run /ship (push branch + open PR) with this PR body:\n\n```\n## [Feature Name]\n\n**Plan:** docs/[slug]/plan.md\n**Build:** Tests [N passing] | Coverage [N%] | Lint [clean]\n\n### What changed\n[2-3 bullet points from the implementation]\n\n### P1 findings\n[resolved list — or "None / accepted as-is"]\n\n### P2 findings resolved\n[count] fixed\n\n### Test coverage delta\n[N% → N%]\n```\n\n3. Output the PR URL.\n\nDo NOT merge. Human reviews the PR.', }, [s9], false);

    step(wfId, s11, 'Phase 4 Complete',
      'Phase 4 — Review complete. PR is open.',
      650, 1130, 'connector',
      { connectorType: 'system-notify', title: 'CE Phase 4 — Review Done', message: 'PR is open. Advance to Phase 5 — QA.' }, [s10]);
  }

  // ── CE Phase 5 — QA ───────────────────────────────────────────────────
  {
    const wfId = randomUUID();
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(), s5 = randomUUID();
    insertWorkflow.run(wfId, 'CE: Phase 5 — QA',
      'Real-browser QA on staging. Walk every user flow, fix bugs with atomic commits, write regression tests. Enter [slug] and [staging URL] in launch context.', now);

    step(wfId, s1, 'QA Browser Run',
      'Run /qa [staging URL]: real Chromium, walk all flows from the plan, fix each bug atomically, write regression tests.',
      300, 80, 'claude-code',
      { ...cc('tester'), workflowContext: true, prompt: 'The feature slug and staging URL are in workflow context above.\n\nRun /qa on the staging URL:\n1. Launch a real browser and navigate to the staging environment.\n2. Read docs/[slug]/plan.md — identify every user flow defined there.\n3. Walk through EVERY flow systematically:\n   - Happy path\n   - Each edge case from the plan\n   - Error states (invalid input, network failure, empty state)\n4. For each bug found:\n   a. Document: what you did → what happened → what was expected\n   b. Fix it with one atomic commit: "fix: [slug] QA — [description]"\n   c. Write a regression test that would have caught it\n   d. Re-verify the fix in the browser before moving on\n5. Continue until all flows pass.\n\nOutput:\n```\n## QA Run — [feature name]\n\n### Flows Tested\n[list each flow with ✅ PASS or 🐛 BUG FOUND + FIXED]\n\n### Bugs Found and Fixed\n[bug description | commit | regression test written]\n\n### Flows Failing (if any)\n[description + what was tried]\n\nSTATUS: [ALL FLOWS PASSING] | [N FLOWS FAILING]\n```' }, []);

    step(wfId, s2, 'CE Three Questions',
      'Ask the 3 CE implementation quality questions. Answers expose hidden uncertainty before shipping.',
      300, 255, 'claude-code',
      { ...cc('reviewer'), prompt: 'Answer these 3 CE quality questions about this implementation honestly:\n\n**Q1 — HARDEST DECISION**: What was the hardest technical decision made in this implementation? Why was it hard? What was the alternative?\n\n**Q2 — REJECTED ALTERNATIVES**: What other approaches were considered and rejected? For each: what was it, why was it rejected, and could rejecting it turn out to be wrong?\n\n**Q3 — LEAST CONFIDENT**: What part of this implementation are you least confident about? What could go wrong with it in production that you have not fully accounted for?\n\nBe honest. The goal is to surface real uncertainty, not to look good.\n\nAppend answers to todos/[slug]/qa-report.md.' }, [s1]);

    step(wfId, s3, 'Investigate Uncertainties',
      'Run /investigate on anything flagged as uncertain. Iron Law: no fixes without root cause first. Escalate after 3 failed attempts.',
      300, 430, 'claude-code',
      { ...cc('reviewer'), prompt: 'Read the CE Three Questions output above. For each item flagged as uncertain:\n\nRun /investigate — Iron Law: never fix before understanding root cause.\n\nFor each uncertain item:\n1. Form a hypothesis: "I think X because Y"\n2. Test the hypothesis: read the relevant code, add a debug log, check the failing test\n3. If hypothesis is wrong: form a new one. Max 3 attempts per item.\n4. If confirmed: document the root cause and either fix it or escalate.\n\nEscalation rule: if after 3 attempts you cannot determine root cause → write to todos/[slug]/escalations.md and mark for human review. Do NOT attempt a fix.\n\nOutput:\n```\n## Investigation Results\n\n### [Uncertainty 1]\nHypothesis: [what you thought]\nFindings: [what you found]\nOutcome: [RESOLVED: fix applied] | [ESCALATED: see todos/[slug]/escalations.md]\n```' }, [s2]);

    step(wfId, s4, 'QA Report',
      'Write final todos/[slug]/qa-report.md. Pauses for human review if any flows are failing or escalations exist.',
      300, 605, 'claude-code',
      { ...cc('planner'), prompt: 'Compile the final QA report.\n\nWRITE todos/[slug]/qa-report.md:\n- ## QA Summary\n- ## Flows Tested (count + list with pass/fail)\n- ## Bugs Found and Fixed (count + descriptions + commits)\n- ## Regression Tests Added (count + file locations)\n- ## CE Three Questions Answers\n- ## Escalations (if any — link to todos/[slug]/escalations.md)\n- ## Status: ALL PASSING | N FAILING\n\nOutput gate summary:\n```\n## Phase 5 — QA REPORT\n\nFlows tested: [count]\nBugs found and fixed: [count]\nRegression tests added: [count]\nEscalations: [count — or "None"]\n\nSTATUS: [ALL FLOWS PASSING — advance to Phase 6] | [ESCALATIONS EXIST — human decision required]\n```\n\nIf escalations exist or any flows are failing: do NOT advance automatically.', }, [s3], false);

    step(wfId, s5, 'Phase 5 Complete',
      'Phase 5 — QA complete. All flows passing.',
      300, 780, 'connector',
      { connectorType: 'system-notify', title: 'CE Phase 5 — QA Done', message: 'QA passed. Review qa-report then advance to Phase 6 — Ship.' }, [s4]);
  }

  // ── CE Phase 6 — Ship ─────────────────────────────────────────────────
  {
    const wfId = randomUUID();
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(), s4b = randomUUID(), s4c = randomUUID(), s5 = randomUUID();
    insertWorkflow.run(wfId, 'CE: Phase 6 — Ship',
      'Document release → human merge approval → land & deploy → 10-min canary → decision checkpoint (all clear / rollback / hotfix).', now);

    step(wfId, s1, 'Document Release',
      'Run /document-release: cross-reference the diff against all docs, update stale content, flag gaps.',
      300, 80, 'claude-code',
      { ...cc('planner'), workflowContext: true, prompt: 'You are running /document-release for the [slug] feature.\n\n1. Read the full diff: git diff main...HEAD\n2. Read every documentation file in the project: README.md, ARCHITECTURE.md, CONTRIBUTING.md, CLAUDE.md, any docs/ files.\n3. For each doc file: does the diff change anything this document describes? If yes, update it.\n4. Cross-reference the implementation against the docs. Flag any documentation that:\n   - Describes behavior that no longer exists\n   - Is missing documentation for new behavior\n   - Has stale file paths, function names, or configuration keys\n5. Update what you can automatically. Flag what requires human judgment.\n\nOutput:\n```\n## Document Release Report\n\n### Files Updated\n[file | what was updated]\n\n### Stale Docs Flagged (require human update)\n[file | what is stale | why it needs human judgment]\n\n### Coverage\n[All docs current] | [N items flagged for human review]\n```' }, []);

    step(wfId, s2, 'Merge Gate',
      'Human merge approval gate. Review the PR, QA report, and doc release report before approving merge.',
      300, 255, 'claude-code',
      { ...cc('planner'), prompt: 'Prepare the merge approval summary for human review.\n\nCollect and summarize:\n1. PR URL and title\n2. QA status from todos/[slug]/qa-report.md\n3. Doc release status from above\n4. Build summary: tests, coverage, lint\n5. Any remaining P1 findings\n\nOutput:\n```\n## Phase 6 — AWAITING MERGE APPROVAL\n\nPR: [URL]\nQA: [ALL FLOWS PASSING]\nDocs: [updated / N items flagged]\nBuild: Tests [N] | Coverage [N%] | Lint [clean]\nP1 findings: [None | list]\n\nTo merge: advance this step manually.\nTo hold: reject with reason.\n```\n\nDo NOT merge automatically. Do NOT advance automatically.', }, [s1], false);

    step(wfId, s3, 'Land & Deploy',
      'Run /land-and-deploy: merge PR, wait for CI, deploy, verify production health endpoint.',
      300, 430, 'claude-code',
      { ...cc('backend'), prompt: 'Human has approved the merge. Run /land-and-deploy:\n\n1. MERGE the PR (do not squash unless project convention requires it).\n2. Wait for CI to complete — poll every 30 seconds. Fail loudly if CI fails.\n3. Wait for the deploy to complete — check the deploy pipeline status.\n4. VERIFY production health: hit the health endpoint and confirm 200 OK.\n5. Do a quick smoke test: navigate to the feature in production, confirm it loads.\n\nOutput:\n```\n## Deploy Status\n\nMerge: [commit SHA]\nCI: [PASSED in Nm]\nDeploy: [COMPLETED at HH:MM]\nHealth check: [200 OK]\nSmoke test: [PASS]\n\nProduction is live.\n```' }, [s2]);

    step(wfId, s4, 'Canary Watch',
      'Monitor production for 10 minutes post-deploy. Watch for console errors, performance regressions, page failures.',
      300, 605, 'claude-code',
      { ...cc('reviewer'), prompt: 'Monitor production for 10 minutes after deploy.\n\nWatch for:\n1. Console errors / JS exceptions in the browser\n2. API error rate increase (check logs or monitoring)\n3. Page load time regression (>20% slower than baseline)\n4. Any 4xx or 5xx errors from the new feature endpoints\n5. User-visible failures in the feature flows\n\nCheck every 2 minutes. After 10 minutes, report:\n\n```\n## Canary Report — [feature name]\n\nDuration: 10 minutes\nErrors found: [count]\nPerformance regression: [None | description]\nPage failures: [None | description]\n\nCANARY STATUS: [CLEAN] | [REGRESSION: description]\n```' }, [s3]);

    step(wfId, s4b, 'Canary Decision',
      'Human decision: review the 10-minute canary report and choose the recovery path.',
      300, 780, 'decision',
      {
        question: 'Canary watch complete. What is the production status?',
        eli10: 'The canary ran for 10 minutes watching production. Read the Canary Report above before choosing. When in doubt, rollback — it\'s always reversible.',
        stakes: 'A regression in production affects real users right now. Rollback is safe and reversible. Hotfix is riskier but avoids downtime.',
        recommendation: 'all-clear',
        options: [
          { id: 'all-clear', label: 'All clear — proceed to Compound', description: 'Canary is clean. No errors, no regressions. The feature is stable in production.' },
          { id: 'rollback', label: 'Rollback immediately', description: 'Regression confirmed. Revert the merge and restore the previous production state.' },
          { id: 'hotfix', label: 'Ship a hotfix', description: 'Regression is minor and fixable in-place. Patch and redeploy without reverting.' },
        ],
      }, [s4]);

    step(wfId, s4c, 'Recovery Action',
      'Execute the chosen recovery: pass through on all-clear, rollback the merge, or implement and deploy a hotfix.',
      300, 955, 'claude-code',
      { ...cc('backend'), prompt: 'The canary decision is above. Execute based on the choice:\n\n**If ALL CLEAR:**\nNo action needed. Output: "Production is stable. Proceeding to Phase 7."\n\n**If ROLLBACK:**\n1. Revert the merge commit: `git revert <merge-sha> --no-edit`\n2. Push the revert: `git push`\n3. Wait for CI and deploy to complete.\n4. Verify the health endpoint returns 200 OK.\n5. Output: "Rollback complete. Feature reverted. Re-plan from Phase 2 if you want to retry."\n\n**If HOTFIX:**\n1. Identify the regression from the canary report.\n2. Implement the minimal fix.\n3. Commit: "hotfix: [slug] — [description of regression fix]"\n4. Push and wait for CI + deploy.\n5. Verify the regression is gone in production.\n6. Output: "Hotfix deployed. Verify production before proceeding."' }, [s4b]);

    step(wfId, s5, 'Phase 6 Complete',
      'Phase 6 — Ship complete. Feature is live in production.',
      300, 1130, 'connector',
      { connectorType: 'system-notify', title: 'CE Phase 6 — Shipped!', message: 'Phase 6 complete. Advance to Phase 7 — Compound.' }, [s4c]);
  }

  // ── CE Phase 7 — Compound ─────────────────────────────────────────────
  {
    const wfId = randomUUID();
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(), s5 = randomUUID();
    insertWorkflow.run(wfId, 'CE: Phase 7 — Compound',
      'Make the next feature cheaper. CE compound → update CLAUDE.md → retro → learn. The most important phase — do not skip.', now);

    step(wfId, s1, 'CE Compound',
      'Run CE /ce-compound: 6 parallel subagents extract what was learned and write docs/solutions/[slug].md.',
      300, 80, 'claude-code',
      { ...cc('researcher'), workflowContext: true, prompt: 'You are running CE /ce-compound for the [slug] feature. Canary is clean.\n\nSpawn 6 parallel research tasks and synthesize:\n\n**context-analyzer**: What problem did this feature solve? What was the real user need vs. the stated requirement?\n\n**solution-extractor**: What worked well in this implementation? What did not work and had to be abandoned? What surprised you?\n\n**related-docs-finder**: Search docs/solutions/ for existing compound docs. What prior learnings applied here? What was missing?\n\n**prevention-strategist**: What mistakes were made or nearly made? How would you detect this class of problem earlier next time?\n\n**category-classifier**: Tag this solution for future retrieval. Categories: auth | data | performance | ui | api | testing | architecture | devops | other. Also tag: language, framework, scope (component/service/system).\n\n**documentation-writer**: Format the final searchable document.\n\nWRITE docs/solutions/[slug].md with YAML frontmatter:\n```yaml\n---\ntitle: [feature name]\nslug: [slug]\ncategories: [list]\ntags: [list]\ndate: [today]\n---\n```\nThen sections: ## Problem, ## Solution, ## What Worked, ## What Did Not Work, ## Prevention, ## Related Docs, ## Key Code References' }, []);

    step(wfId, s2, 'Update CLAUDE.md',
      'Add new patterns, anti-patterns, taste decisions, and caveats discovered in this sprint to CLAUDE.md.',
      300, 255, 'claude-code',
      { ...cc('planner'), prompt: 'Read the compound doc from the previous step and the full git log for this sprint.\n\nUpdate CLAUDE.md — add to the relevant sections:\n- NEW PATTERNS: things that worked well that should be repeated\n- ANTI-PATTERNS: things that went wrong or nearly went wrong — include early detection signals\n- TASTE DECISIONS: naming, structure, approach choices made — and why\n- CAVEATS: project-specific constraints discovered\n\nRule: if an agent made a mistake during this sprint that another agent or human had to correct, add a note so it will not happen again next sprint.\n\nDo not remove existing content unless it is now factually wrong. Mark superseded patterns as deprecated with a note.\n\nOutput: list of sections updated and what was added.' }, [s1]);

    step(wfId, s3, 'Retro',
      'Run /retro: velocity vs estimate, top 3 blockers, coverage trend. Write docs/retros/[date]-[slug].md.',
      300, 430, 'claude-code',
      { ...cc('planner'), prompt: 'Run /retro for the [slug] sprint.\n\nGather from git log, todos, and build summary:\n1. VELOCITY: estimated effort (from Phase 1) vs. actual time spent\n2. COVERAGE TREND: coverage at start of sprint vs. end\n3. PHASE ANALYSIS: which phase took longest? Which was smoothest?\n4. TOP 3 BLOCKERS: what slowed the team down most?\n5. WHAT TO REPEAT: what went well that we should do more of?\n6. WHAT TO CHANGE: what would we do differently?\n\nToday\'s date: use the current date.\n\nWRITE docs/retros/[today-date]-[slug].md with all sections.\n\nOutput a summary: velocity ratio (estimated/actual), coverage delta, top 3 blockers.' }, [s2]);

    step(wfId, s4, 'Learn & Final Review',
      'Run /learn: review new learnings, prune superseded ones, verify CLAUDE.md is current. Final human sign-off.',
      300, 605, 'claude-code',
      { ...cc('planner'), prompt: 'Run /learn for the [slug] sprint.\n\n1. Review all learnings added in this sprint (from CLAUDE.md updates in previous step).\n2. Search for any existing learnings that are now superseded by what we learned — mark them as deprecated.\n3. Verify CLAUDE.md is consistent (no contradictions, no stale file paths or function names).\n4. Confirm docs/solutions/[slug].md is written and well-structured.\n\nOutput final compound summary:\n```\n## Phase 7 — COMPOUND COMPLETE\n\nFeature: [name] is live in production\nCompound doc: docs/solutions/[slug].md\nCLAUDE.md: updated with [N] new patterns, [N] anti-patterns\nRetro: docs/retros/[date]-[slug].md\nNew learnings added: [N]\nSuperseded learnings pruned: [N]\n\nThe system is now smarter than it was before this feature was built.\n\nAdvance to close this sprint.\n```\n\nDo NOT advance automatically.', }, [s3], false);

    step(wfId, s5, 'Sprint Complete',
      'Full Compound Engineering sprint complete. Feature live, learnings captured, system improved.',
      300, 780, 'connector',
      { connectorType: 'system-notify', title: 'CE Sprint Complete 🎯', message: 'Feature is live, compound doc written, CLAUDE.md updated, retro done. The system is smarter.' }, [s4]);
  }

  // ── CE: Full Delivery — all 7 phases chained ──────────────────────────
  {
    const wfId = randomUUID();

    // Phase 1 IDs
    const p1s1 = randomUUID(), p1s2 = randomUUID(), p1s2b = randomUUID(), p1s3 = randomUUID(), p1s4 = randomUUID(), p1s5 = randomUUID();
    // Phase 2 IDs
    const p2s1 = randomUUID(), p2s2 = randomUUID(), p2s3 = randomUUID(), p2s4 = randomUUID(), p2s5 = randomUUID(), p2s6 = randomUUID();
    // Phase 3 IDs
    const p3s1 = randomUUID(), p3s1b = randomUUID(), p3s2 = randomUUID(), p3s3 = randomUUID(), p3s4 = randomUUID(), p3s5 = randomUUID();
    // Phase 4 IDs
    const p4s1 = randomUUID(), p4s2 = randomUUID(), p4s3 = randomUUID(), p4s4 = randomUUID(), p4s5 = randomUUID(), p4s6 = randomUUID(), p4s7 = randomUUID(), p4s8 = randomUUID(), p4s8b = randomUUID(), p4s9 = randomUUID(), p4s10 = randomUUID(), p4s11 = randomUUID();
    // Phase 5 IDs
    const p5s1 = randomUUID(), p5s2 = randomUUID(), p5s3 = randomUUID(), p5s4 = randomUUID(), p5s5 = randomUUID();
    // Phase 6 IDs
    const p6s1 = randomUUID(), p6s2 = randomUUID(), p6s3 = randomUUID(), p6s4 = randomUUID(), p6s4b = randomUUID(), p6s4c = randomUUID(), p6s5 = randomUUID();
    // Phase 7 IDs
    const p7s1 = randomUUID(), p7s2 = randomUUID(), p7s3 = randomUUID(), p7s4 = randomUUID(), p7s5 = randomUUID();

    insertWorkflow.run(wfId, 'CE: Full Delivery',
      'All 7 phases chained end-to-end. Interrogate → Plan → Implement → Review → QA → Ship → Compound. Enter feature slug + description in launch context.', now);

    // ── Phase 1 (y: 80–780) ────────────────────────────────────────────
    step(wfId, p1s1, '[P1] Load Prior Work',         'Search CLAUDE.md and docs/solutions/ for prior patterns.',               300,   80, 'claude-code', { ...cc('researcher'), workflowContext: true, prompt: 'The feature name/slug is in the workflow context above.\n\n1. READ CLAUDE.md — extract patterns, anti-patterns, taste decisions, and caveats relevant to this feature area.\n2. SEARCH docs/solutions/ for any compound docs related to this domain. Read any relevant ones.\n3. SEARCH docs/brainstorms/ and docs/plans/ for any prior work on this feature.\n\nOutput a Prior Work Summary:\n```\n## Prior Work Summary\n\n### CLAUDE.md Relevant Notes\n[bullet list — or "None"]\n\n### Prior Compound Docs Found\n[names and 1-sentence summary each — or "None"]\n\n### Prior Brainstorms / Plans Found\n[names and key decisions — or "None"]\n\n### Verdict\n[CLEAN START — no relevant prior work] or [PRIOR WORK EXISTS — key context: ...]\n```' }, []);
    step(wfId, p1s2, '[P1] Office Hours',            'Run /office-hours: 6 forcing questions, 2–3 approaches, effort estimate.', 300,  255, 'claude-code', { ...cc('planner'), prompt: 'You are running /office-hours. Prior work findings are above.\n\nAsk 6 forcing questions — answer each based on the feature context:\n\n**Q1 — DEMAND REALITY**: Who specifically wants this? How do we know?\n**Q2 — STATUS QUO**: What are users doing right now without this? Why is that not enough?\n**Q3 — DESPERATE SPECIFICITY**: Describe the one person most desperate for this. What is their exact situation?\n**Q4 — NARROWEST WEDGE**: What is the smallest version that still delivers real value?\n**Q5 — OBSERVATION**: Have we watched someone try to do this? What actually happened?\n**Q6 — FUTURE FIT**: In 2 years, does this feature become more or less relevant? Why?\n\nThen generate 2–3 implementation approaches:\nFor each: name, one-sentence description, effort (S/M/L), key assumption, biggest risk.\n\nEnd with:\n```\n## Recommended Approach\n[name]: [why]\n\n## Key Assumptions\n- [list]\n\n## Estimated Effort: [S/M/L]\n```' }, [p1s1]);
    step(wfId, p1s2b, '[P1] Pick Approach',          'Human decision: choose which approach to pursue into brainstorm and plan.',300,  430, 'decision',    { question: 'Which implementation approach should we pursue?', eli10: 'Office Hours just explored 2–3 ways to build this. Pick one — it shapes the entire plan. Read the step output above before choosing.', stakes: 'This choice locks the architecture for the sprint. Switching approaches mid-build is expensive.', recommendation: 'approach-recommended', options: [{ id: 'approach-recommended', label: 'Recommended approach', description: 'Pursue the approach Office Hours flagged as recommended.' }, { id: 'approach-alternative', label: 'Alternative approach', description: 'Use one of the non-recommended alternatives. Specify which in CE Brainstorm.' }, { id: 'approach-minimal', label: 'Narrowest wedge only', description: 'Build the absolute minimum version — fastest to ship but least complete.' }] }, [p1s2]);
    step(wfId, p1s3, '[P1] CE Brainstorm',           'Repo research, clarify purpose/constraints, define done.',               300,  605, 'claude-code', { ...cc('researcher'), prompt: 'You are running CE /ce-brainstorm. The chosen approach (from the decision step above) and Office Hours output are in context — build on them, do not repeat.\n\n1. REPO RESEARCH — use Read, Grep, Glob:\n   - Find existing code related to this feature\n   - Identify files and modules that will be touched\n   - Note established patterns you must follow\n   - Flag constraints (locked interfaces, technical debt)\n\n2. CLARIFY (for the CHOSEN approach only):\n   - Purpose (what does this solve at the code level?)\n   - Users (which flows are affected?)\n   - Hard constraints (what must NOT change?)\n   - Top 3 edge cases\n\n3. DEFINE DONE — concrete, observable criteria.\n\nOutput:\n```\n## CE Brainstorm\n\n### Chosen Approach\n[restate the chosen approach]\n\n### Repo Research\n[files affected, patterns to follow, constraints]\n\n### Clarified Purpose\n[one paragraph]\n\n### Top Edge Cases\n1. [case + handling]\n2. [case + handling]\n3. [case + handling]\n\n### Definition of Done\n- [ ] [criterion]\n```' }, [p1s2b]);
    step(wfId, p1s4, '[P1] Write Brainstorm Doc',    'Merge outputs → docs/[slug]/brainstorm.md. Human gate.',                  300,  605, 'claude-code', { ...cc('planner'), prompt: 'Merge all prior step outputs into a canonical brainstorm document.\n\n1. Determine the feature slug from context (lowercase-hyphenated, e.g. "user-auth-v2").\n2. Create docs/[slug]/ directory if needed.\n3. WRITE docs/[slug]/brainstorm.md:\n   - ## Problem Statement\n   - ## Recommended Approach (one sentence)\n   - ## Approaches Considered (table: name | effort | key assumption | risk)\n   - ## Scoped Definition (in / out)\n   - ## Files / Modules Affected\n   - ## Constraints\n   - ## Top Edge Cases\n   - ## Definition of Done (checklist)\n   - ## Open Questions\n   - ## Prior Work References\n   - ## Effort Estimate: [S/M/L]\n\n4. Output gate summary:\n```\n## Phase 1 — AWAITING HUMAN REVIEW\n\nFeature: [name] | Slug: [slug]\nRecommended approach: [one sentence]\nKey assumptions: [bullet list]\nEstimated effort: [S/M/L]\nFile written: docs/[slug]/brainstorm.md\n\nAdvance manually after reviewing the brainstorm doc.\n```\n\nDo NOT advance automatically.' }, [p1s3], false);
    step(wfId, p1s5, '[P1] ✓ Interrogate Done',      'Phase 1 complete — notify.',                                              300,  780, 'connector',   { connectorType: 'system-notify', title: 'CE Full Delivery — P1 Done', message: 'Brainstorm ready. Review then advance to Phase 2.' }, [p1s4]);

    // ── Phase 2 (y: 1000–1600, parallel at y=1175) ─────────────────────
    step(wfId, p2s1, '[P2] Load Brainstorm',          'Read brainstorm doc, prepare context for parallel reviews.',             450, 1000, 'claude-code', { ...cc('researcher'), prompt: 'Read docs/[slug]/brainstorm.md in full.\n\nOutput a structured summary:\n```\n## Brainstorm Summary for Plan Review\n\nFeature: [name] | Slug: [slug]\nRecommended Approach: [one sentence]\nEffort: [S/M/L]\n\n### Files / Modules Affected\n[list]\n\n### Key Constraints\n[list]\n\n### Open Questions from Phase 1\n[list]\n\n### Definition of Done\n[checklist]\n```\n\nThis feeds three parallel reviews that run simultaneously.' }, [p1s4]);
    step(wfId, p2s2, '[P2] /plan-ceo-review',         'Scope check, 10-star test, 4 scope modes. Parallel.',                   150, 1175, 'claude-code', { ...cc('planner'), prompt: 'You are running /plan-ceo-review. Brainstorm summary is above.\n\nPick ONE of 4 scope modes and argue it:\n- EXPANSION: should we build MORE? What value are we leaving on the table?\n- SELECTIVE EXPANSION: core + one high-value addition. What is the addition?\n- HOLD SCOPE: the proposal is right as stated. Defend it.\n- REDUCTION: we are overbuilding. What is the minimum that still delivers real value?\n\nRun the 10-star product test:\n- 7/10 version (mediocre but ships): [description]\n- 10/10 version (legendary, 10x longer): [description]\n- Recommended target: [N/10] — [why]\n\nOutput:\n```\n## CEO Review\n\n### Mode: [NAME]\n[3-4 sentence argument]\n\n### 10-Star Test\n7/10: [description]\n10/10: [description]\nTarget: [N/10] — [why]\n\n### Scope Recommendation\nIn: [list] | Out: [list]\n\n### Risk Flags\n- [flag]\n- [flag]\n```' }, [p2s1]);
    step(wfId, p2s3, '[P2] /plan-eng-review',         'Architecture, data flow, edge cases, test matrix. Parallel.',           450, 1175, 'claude-code', { ...cc('architect'), prompt: 'You are running /plan-eng-review. Brainstorm summary is above.\n\n1. DATA FLOW — draw ASCII diagram: User action → [layers] → DB/API → response → UI state\n\n2. AFFECTED FILES — table: File | Change Type | Why\n\n3. KEY INTERFACES — types/interfaces to create or modify\n\n4. EDGE CASES — top 5: Case | Input | Expected behavior | Failure mode\n\n5. TEST MATRIX — minimum test coverage: Test | Type (unit/integration/e2e) | What it verifies\n\n6. FAILURE MODES — what breaks in production if this fails?\n\n7. SECURITY CONCERNS — auth, authorization, input validation, data exposure at design level\n\nOutput all sections clearly labeled.' }, [p2s1]);
    step(wfId, p2s4, '[P2] CE Plan Research',         'Repo patterns + framework docs + best practices. Parallel.',            750, 1175, 'claude-code', { ...cc('researcher'), prompt: 'You are running CE /ce-plan research. Brainstorm summary is above.\n\nRun three parallel research tracks:\n\n**TRACK 1 — REPO PATTERNS**: Search codebase for existing patterns for this feature type, prior implementations, naming/file/test conventions.\n\n**TRACK 2 — FRAMEWORK DOCS**: Identify frameworks/libraries this feature uses. Official approach, version constraints, recommended patterns.\n\n**TRACK 3 — BEST PRACTICES**: Industry-standard approaches, common mistakes, security/performance best practices.\n\nSynthesize into:\n```\n## CE Plan Research\n\n### Existing Codebase Patterns\n[what to follow, what already exists]\n\n### Framework Guidance\n[official approach + version constraints]\n\n### Industry Best Practices\n[key patterns + pitfalls to avoid]\n\n### Implementation Recommendations\n- [specific recommendation]\n- [specific recommendation]\n```' }, [p2s1]);
    step(wfId, p2s5, '[P2] Write Plan Doc',           'Merge reviews → docs/[slug]/plan.md. Human gate.',                      450, 1350, 'claude-code', { ...cc('planner'), prompt: 'Merge all three parallel review outputs into a canonical plan document.\n\nWRITE docs/[slug]/plan.md:\n- ## Overview (what, why, how — one paragraph)\n- ## Scope (in / out — from CEO review)\n- ## Architecture (data flow ASCII + interfaces — from Eng review)\n- ## Affected Files (table: file | change type | why)\n- ## Implementation Steps (numbered, ordered, each step is one actionable task)\n- ## Test Plan (table: test | type | what it verifies)\n- ## Security Checklist (from Eng review)\n- ## Rollback Plan\n- ## Open Decisions\n\nOutput gate summary:\n```\n## Phase 2 — AWAITING HUMAN REVIEW\n\nFeature: [name] | Slug: [slug]\nAffected files: [count]\nImplementation steps: [count]\nRisks: [bullet list]\nOpen decisions: [bullet list]\nFile written: docs/[slug]/plan.md\n```\n\nDo NOT advance automatically.' }, [p2s2, p2s3, p2s4], false);
    step(wfId, p2s6, '[P2] ✓ Plan Done',              'Phase 2 complete — notify.',                                             450, 1525, 'connector',   { connectorType: 'system-notify', title: 'CE Full Delivery — P2 Done', message: 'Plan ready. Review then advance to Phase 3.' }, [p2s5]);

    // ── Phase 3 (y: 1745–2795) ─────────────────────────────────────────
    step(wfId, p3s1, '[P3] Load Plan + Worktree',    'Read plan, create git worktree, output step checklist.',                 300, 1745, 'claude-code', { ...cc('architect'), prompt: 'Read docs/[slug]/plan.md in full.\n\nCreate an isolated git worktree:\n  git worktree add ../[slug]-work feature/[slug]\nIf it already exists, verify it is on the correct branch.\n\nOutput:\n```\n## Phase 3 Setup\n\nFeature: [name] | Slug: [slug]\nWorktree: ../[slug]-work\nBranch: feature/[slug]\nPlan loaded: [N] implementation steps\n\n### Step Checklist\n[ ] Step 1: [name]\n[ ] Step 2: [name]\n[all steps from plan]\n```' }, [p2s5]);
    step(wfId, p3s1b, '[P3] Write Failing Tests',    'TDD: write real failing tests for every item in the plan\'s test matrix before any implementation code exists. Commit the test files.', 300, 1920, 'claude-code', { ...cc('tester'), prompt: 'Read the Test Plan section from docs/[slug]/plan.md. Write real, runnable tests for every item in that plan — before any implementation code exists.\n\n### PHASE 1 — FIND TEST CONVENTIONS\n1. Search the project for existing test files: `*.test.ts`, `*.spec.ts`, `*.test.tsx`, `__tests__/`, `test/`, `spec/`.\n2. Read 2-3 representative test files to understand: framework (Jest, Vitest, etc.), assertion style, mock patterns, file naming, and import conventions.\n\n### PHASE 2 — WRITE FAILING TESTS\nFor each row in the Test Plan table from docs/[slug]/plan.md:\n1. Write a real test using the project\'s framework and conventions.\n2. Each test must cover: happy path + at least 2 edge cases + at least 1 error state per requirement.\n3. Place each test in the correct file — extend an existing test file or create a new one following project conventions.\n4. Do NOT write implementation code. Import the functions/modules by their final intended path — they may not exist yet, and that is expected.\n\n### PHASE 3 — CONFIRM THEY FAIL\nRun the test suite (or just the new test files) and confirm that every new test FAILS.\n- If a test passes before any implementation: the test is wrong — rewrite it so it actually verifies the behavior.\n- If a test fails with "module not found": that is acceptable — the implementation file does not exist yet.\n\n### OUTPUT\n```\n## TDD Test Manifest\n\n### Tests Written\n| File | Test Name | Plan Row | Status |\n|------|-----------|----------|--------|\n[one row per test — Status must be FAIL or MODULE NOT FOUND]\n\n### Test Run Output\n[paste relevant test runner output]\n\n### Summary\nTests written: N | All failing: [YES / NO — if NO, list the ones that incorrectly pass]\n```\n\nCommit the test files: "test: [slug] — write failing TDD tests for Phase 3"' }, [p3s1]);
    step(wfId, p3s2, '[P3] CE Implement',            'Execute plan steps sequentially, WIP commits after each.',              300, 2095, 'claude-code', { ...cc('backend'), prompt: 'Execute every implementation step in the plan IN ORDER. Failing tests from the previous step define the target behavior.\n\nRules:\n1. After each file changed: run the linter/type-checker for that file.\n2. After each step: WIP commit — "WIP: [slug] — step N: [name]"\n3. If a step reveals a problem: adapt, implement better, document the deviation.\n4. Do NOT modify the test files written in the previous step — make the implementation satisfy them.\n5. Do NOT open a PR.\n\nOutput:\n```\n## Implementation Complete\n\n### Steps\n[numbered — ✅ done or ⚠️ DEVIATED: [what and why]]\n\n### Files Changed\n[list]\n\n### Deviations\n[list — or "None"]\n```' }, [p3s1b]);
    step(wfId, p3s3, '[P3] Run Tests',               'Full test suite. Routes back to Implement if failing (max 3 cycles).',  300, 2270, 'quality-gate', { ...gate('test'), routingRules: [{ id: randomUUID(), condition: 'contains', value: 'STATUS: FAIL', nextStepId: p3s2 }], maxCycles: 3 }, [p3s2]);
    step(wfId, p3s4, '[P3] Build Summary',           'Type check, lint, coverage. Write todos/[slug]/build-summary.md.',     300, 2445, 'claude-code', { ...cc('reviewer'), prompt: 'Run full pre-merge verification. Do NOT open a PR.\n\n1. TYPE CHECK: tsc --noEmit. Report: clean / N errors.\n2. LINT: report: clean / N issues.\n3. COVERAGE: N%. Flag if below threshold.\n\nWRITE todos/[slug]/build-summary.md.\n\nOutput:\n```\nSTATUS: [PASS — ready for Phase 4] | [FAIL — resolve first]\n\nTests: [N passing / N failing]\nType check: [clean / N errors]\nLint: [clean / N issues]\nCoverage: [N%]\n```' }, [p3s3]);
    step(wfId, p3s5, '[P3] ✓ Implement Done',        'Phase 3 complete — notify.',                                            300, 2620, 'connector',   { connectorType: 'system-notify', title: 'CE Full Delivery — P3 Done', message: 'Build complete. Starting Phase 4 — Review.' }, [p3s4]);

    // ── Phase 4 (y: 2665–3615, parallel at y=2840) ─────────────────────
    step(wfId, p4s1,  '[P4] Load Diff + Build',       'Read plan, diff, build summary. Prepare dispatch context.',             650, 2665, 'claude-code', { ...cc('reviewer'), prompt: 'READ docs/[slug]/plan.md, READ todos/[slug]/build-summary.md, run git diff main...HEAD.\n\nOutput dispatch context:\n```\n## Review Dispatch Context\n\nFeature: [name] | Slug: [slug]\nBranch: feature/[slug]\nFiles changed: [count] — [list]\nTests: [pass/fail count]\nCoverage: [N%]\n\n### Diff Summary\n[brief per-file description]\n```' }, [p3s4]);
    step(wfId, p4s2,  '[P4] Security Sentinel',       'CE security-sentinel: OWASP Top 10 + injection + auth. Parallel.',      100, 2840, 'claude-code', { ...cc('reviewer'), prompt: 'You are CE security-sentinel. Diff and context are above.\n\nAudit for OWASP Top 10:\n1. Injection (SQL, command, XSS, template)\n2. Broken auth / session management\n3. Sensitive data exposure\n4. Broken access control\n5. Security misconfiguration\n6. Insecure deserialization\n7. Missing input validation\n8. Hardcoded credentials\n9. Verbose error messages leaking internals\n10. Insecure transport\n\nFor each: file:line | type | severity | description | fix\n\nEnd with: SECURITY: CLEAN or SECURITY: N FINDINGS' }, [p4s1]);
    step(wfId, p4s3,  '[P4] CSO / STRIDE',            '/cso: STRIDE threat model, 8/10+ confidence only. Parallel.',           330, 2840, 'claude-code', { ...cc('reviewer'), prompt: 'You are running /cso. STRIDE threat model — 8/10+ confidence findings only.\n\nSPOOFING | TAMPERING | REPUDIATION | INFORMATION DISCLOSURE | DENIAL OF SERVICE | ELEVATION OF PRIVILEGE\n\nFor each: threat | file:line | description | impact | mitigation\n\nEnd with: CSO: APPROVED or CSO: N VERIFIED THREATS' }, [p4s1]);
    step(wfId, p4s4,  '[P4] Performance Oracle',      'CE performance-oracle: N+1, indexes, caching, algorithmic. Parallel.',  560, 2840, 'claude-code', { ...cc('reviewer'), prompt: 'You are CE performance-oracle. Diff and context above.\n\nCheck: N+1 queries | missing indexes | full table scans | missing caching | O(n²)+ algorithms | blocking ops | memory leaks | unnecessary re-renders.\n\nFor each: file:line | type | severity | description | fix\n\nEnd with: PERFORMANCE: CLEAN or PERFORMANCE: N FINDINGS' }, [p4s1]);
    step(wfId, p4s5,  '[P4] Architecture Review',     'CE architecture-strategist + pattern-recognition. Parallel.',           790, 2840, 'claude-code', { ...cc('architect'), prompt: 'CE architecture-strategist + pattern-recognition. Diff above.\n\nARCHITECTURE: component boundaries | data flow direction | coupling | correct layer | scalability\nPATTERNS: follows codebase conventions | anti-patterns | YAGNI violations | code smells\n\nFor each: file:line | category | severity | description | recommendation\n\nEnd with: ARCHITECTURE: CLEAN or ARCHITECTURE: N FINDINGS' }, [p4s1]);
    step(wfId, p4s6,  '[P4] Code Quality Review',     'CE simplicity + /review: prod bugs that pass CI, completeness. Parallel.', 1020, 2840, 'claude-code', { ...cc('reviewer'), prompt: 'CE code-simplicity + staff-engineer review. Diff above.\n\nSIMPLICITY: over-complex code | premature abstractions | dead code | unclear names\nPRODUCTION READINESS: unhandled error states | missing loading/empty states | race conditions | hard-coded values | missing logging | incomplete feature\n\nFor each: file:line | category | severity | description | fix\n\nEnd with: QUALITY: CLEAN or QUALITY: N FINDINGS' }, [p4s1]);
    step(wfId, p4s7,  '[P4] Codex',                   '/codex: independent cross-model review. No shared context. Parallel.',  1250, 2840, 'claude-code', { ...cc('reviewer'), prompt: 'You are /codex — independent review with no prior agent context.\n\nRead the diff and plan with fresh eyes:\n1. What does this change do?\n2. Does it match the plan intent?\n3. Top 3 issues you notice independently.\n4. PASS/FAIL verdict for production merge.\n\nOutput:\n```\n## Codex Review\n\n### Top Findings\n1. [file:line] [severity] — [description]\n2. [file:line] [severity] — [description]\n3. [file:line] [severity] — [description]\n\n### Plan Fidelity\n[gaps between code and plan]\n\nCODEX: [PASS | PASS WITH NOTES | FAIL]\n```' }, [p4s1]);
    step(wfId, p4s8,  '[P4] Triage P1/P2/P3',         'Consolidate all 6 agents. P3 auto-resolved. Write p1.md + p2.md.', 650, 3015, 'claude-code', { ...cc('planner'), prompt: 'All 6 parallel review outputs are above. Consolidate and classify.\n\nP1 — must fix before merge: security holes, data loss, broken core functionality\nP2 — should fix: perf issues, architectural debt, incomplete error handling\nP3 — nice to fix → auto-resolve all P3s now\n\n1. Deduplicate findings across agents.\n2. Classify every finding.\n3. AUTO-RESOLVE P3s immediately.\n4. WRITE todos/[slug]/p1.md\n5. WRITE todos/[slug]/p2.md\n\n```\n## Triage\nP1: [count] | P2: [count] | P3: [count auto-resolved]\n```' }, [p4s2, p4s3, p4s4, p4s5, p4s6, p4s7], true);
    step(wfId, p4s8b, '[P4] Review Decision',          'Human decides how to proceed given triage results.',                   650, 3190, 'decision',    { question: 'Triage complete. How do you want to proceed?', eli10: 'The 6 review agents just finished. Triage classified every finding into P1 (must-fix), P2 (should-fix), and P3 (auto-resolved). Check todos/[slug]/p1.md and p2.md for the full list.', stakes: 'P1s are blocking issues — security holes, data loss, broken flows. Proceeding without fixing them ships known defects. Abandoning means the feature is not ready.', recommendation: 'fix-p1s', options: [{ id: 'fix-p1s', label: 'Fix P1s, then proceed', description: 'Agent will fix all P1 and P2 findings before opening the PR. Recommended when P1 count > 0.' }, { id: 'proceed-as-is', label: 'Accept risk and proceed', description: 'Skip P1 fixes — acknowledge the risk. Use only when P1s are false positives you have already verified.' }, { id: 'abandon-pr', label: 'Abandon this PR', description: 'Close the branch without merging. Use when findings reveal a fundamental flaw in the approach.' }] }, [p4s8]);
    step(wfId, p4s9,  '[P4] Resolve Findings',        'Fix P1s and P2s based on review decision.',                           650, 3365, 'claude-code', { ...cc('backend'), includeDepOutput: true, prompt: 'The review decision above specifies how to proceed.\n\nIF decision is "fix-p1s":\n  Read todos/[slug]/p1.md AND todos/[slug]/p2.md.\n  Fix every P1 first (blocking), then every P2.\n  For each: minimal fix → commit "fix: [slug] P1/P2 — [description]" → mark resolved.\n\nIF decision is "proceed-as-is":\n  Read todos/[slug]/p2.md only. Fix P2s. Skip P1s.\n  Note the accepted P1 risk in output.\n\nIF decision is "abandon-pr":\n  Output "PR ABANDONED — [reason from triage]". Stop.\n\nOutput: findings resolved list.' }, [p4s8b]);
    step(wfId, p4s10, '[P4] Open PR',                 'Run /ship to open PR. Human reviews before merge.',                    650, 3540, 'claude-code', { ...cc('planner'), prompt: 'Squash WIP commits, then run /ship to open the PR.\n\nPR body:\n```\n## [Feature Name]\n\nPlan: docs/[slug]/plan.md\nBuild: Tests [N] | Coverage [N%] | Lint clean\n\n### Changes\n[2-3 bullets]\n\n### P1 findings (if any)\n[list or "None"]\n\n### P2 resolved\n[count] fixed\n```\n\nOutput PR URL. Do NOT merge. Do NOT advance automatically.' }, [p4s9], false);
    step(wfId, p4s11, '[P4] ✓ Review Done',            'Phase 4 complete — notify.',                                            650, 3715, 'connector',   { connectorType: 'system-notify', title: 'CE Full Delivery — P4 Done', message: 'PR open. Review P1 findings then advance to Phase 5.' }, [p4s10]);

    // ── Phase 5 (y: 3760–4560) ─────────────────────────────────────────
    step(wfId, p5s1, '[P5] QA Browser Run',          'Run /qa: real Chromium, walk all flows, fix bugs + regression tests.',  300, 3935, 'claude-code', { ...cc('tester'), prompt: 'Run /qa on the staging URL (from context or .env.staging).\n\n1. Launch browser, navigate to staging.\n2. Read docs/[slug]/plan.md — walk EVERY user flow.\n3. For each bug: document → fix with atomic commit → write regression test → re-verify.\n\nOutput:\n```\n## QA Run\n\n### Flows\n[each: ✅ PASS or 🐛 BUG + FIXED]\n\n### Bugs Fixed\n[description | commit | regression test]\n\nSTATUS: [ALL PASSING] | [N FAILING]\n```' }, [p4s10]);
    step(wfId, p5s2, '[P5] CE Three Questions',      'Answer 3 CE quality questions to surface hidden uncertainty.',          300, 4110, 'claude-code', { ...cc('reviewer'), prompt: 'Answer honestly:\n\nQ1 — HARDEST DECISION: What was hardest technically? Why? What was the alternative?\nQ2 — REJECTED ALTERNATIVES: What was considered and rejected? Could rejecting it be wrong?\nQ3 — LEAST CONFIDENT: What could go wrong in production you have not fully accounted for?\n\nAppend to todos/[slug]/qa-report.md.' }, [p5s1]);
    step(wfId, p5s3, '[P5] Investigate',             'Run /investigate on flagged uncertainties. Escalate after 3 failures.', 300, 4285, 'claude-code', { ...cc('reviewer'), prompt: 'For each uncertainty from CE Three Questions: hypothesis → test → confirm or new hypothesis. Max 3 attempts.\n\nEscalate unresolved items to todos/[slug]/escalations.md.\n\nOutput investigation results per item.' }, [p5s2]);
    step(wfId, p5s4, '[P5] QA Report',               'Write todos/[slug]/qa-report.md. Human gate if failures/escalations.',  300, 4460, 'claude-code', { ...cc('planner'), prompt: 'WRITE todos/[slug]/qa-report.md:\n- ## Flows Tested\n- ## Bugs Fixed\n- ## Regression Tests Added\n- ## CE Three Questions\n- ## Escalations\n- ## Status\n\nIf escalations or failures: do NOT advance automatically.\n\n```\nQA STATUS: [ALL PASSING] | [ESCALATIONS EXIST]\n```' }, [p5s3], false);
    step(wfId, p5s5, '[P5] ✓ QA Done',               'Phase 5 complete — notify.',                                            300, 4635, 'connector',   { connectorType: 'system-notify', title: 'CE Full Delivery — P5 Done', message: 'QA passed. Advance to Phase 6 — Ship.' }, [p5s4]);

    // ── Phase 6 (y: 4680–5480) ─────────────────────────────────────────
    step(wfId, p6s1, '[P6] Document Release',        'Cross-reference diff vs all docs. Update stale content. Flag gaps.',   300, 4855, 'claude-code', { ...cc('planner'), prompt: 'Run /document-release.\n\n1. git diff main...HEAD\n2. Read all docs: README, ARCHITECTURE, CONTRIBUTING, CLAUDE.md, docs/\n3. Update stale content. Flag what needs human judgment.\n\nOutput: files updated | items flagged.' }, [p5s4]);
    step(wfId, p6s2, '[P6] Merge Gate',              'Human merge approval. Review PR + QA + docs before proceeding.',       300, 5030, 'claude-code', { ...cc('planner'), prompt: 'Prepare merge approval summary.\n\nCollect: PR URL | QA status | doc release status | build summary | P1 findings.\n\n```\n## Phase 6 — AWAITING MERGE APPROVAL\n\nPR: [URL]\nQA: [status]\nDocs: [status]\nBuild: [summary]\nP1s: [None or list]\n```\n\nDo NOT merge automatically.' }, [p6s1], false);
    step(wfId, p6s3, '[P6] Land & Deploy',           'Merge PR, wait for CI, deploy, verify production health.',             300, 5205, 'claude-code', { ...cc('backend'), prompt: 'Run /land-and-deploy:\n1. Merge PR\n2. Wait for CI — fail loudly if CI fails\n3. Wait for deploy\n4. Verify health endpoint: 200 OK\n5. Smoke test the feature in production\n\nOutput: merge SHA | CI status | deploy status | health check | smoke test.' }, [p6s2]);
    step(wfId, p6s4, '[P6] Canary Watch',            '10-min production monitor.',                                           300, 5380, 'claude-code', { ...cc('reviewer'), prompt: 'Monitor production for 10 minutes.\n\nWatch: console errors | API error rate | page load regression (>20%) | 4xx/5xx on feature endpoints.\n\nCheck every 2 min. After 10 min:\n```\nCANARY: [CLEAN] | [REGRESSION: description]\n```\n\nAlways advance automatically after writing the report.' }, [p6s3], true);
    step(wfId, p6s4b, '[P6] Canary Decision',        'Human decides: all clear, rollback, or hotfix.',                       300, 5555, 'decision',    { question: 'Canary watch complete. What is the production status?', eli10: 'The canary ran for 10 minutes watching for errors, latency spikes, and failures. Check the canary report above — CLEAN means everything is healthy, REGRESSION means something broke.', stakes: 'If there is a regression and you proceed, real users are hitting broken code. Rollback is immediate and safe. Hotfix is faster than rollback if the fix is simple and known.', recommendation: 'all-clear', options: [{ id: 'all-clear', label: 'All clear — proceed to Compound', description: 'Canary is clean. Feature is healthy in production. Proceed to Phase 7.' }, { id: 'rollback', label: 'Rollback immediately', description: 'Revert the deployment. Use when the regression is severe or the fix is not obvious.' }, { id: 'hotfix', label: 'Ship a hotfix', description: 'Agent will diagnose and fix the regression with a targeted patch, then re-verify canary.' }] }, [p6s4]);
    step(wfId, p6s4c, '[P6] Recovery Action',        'Execute rollback or hotfix based on canary decision.',                 300, 5730, 'claude-code', { ...cc('backend'), includeDepOutput: true, prompt: 'The canary decision above specifies the action.\n\nIF decision is "all-clear":\n  Output "CANARY CLEAN — proceeding to Phase 7." No action needed.\n\nIF decision is "rollback":\n  Run /land-and-deploy in rollback mode.\n  Revert to previous deploy. Verify health endpoint returns 200.\n  Output: rollback SHA | health check.\n\nIF decision is "hotfix":\n  Run /investigate on the canary regression.\n  Apply minimal targeted fix → commit → deploy → re-run 5-min canary.\n  If fix fails after 3 attempts: escalate and STOP.\n  Output: fix description | commit | re-canary result.' }, [p6s4b]);
    step(wfId, p6s5, '[P6] ✓ Shipped',               'Feature is live. Notify.',                                             300, 5905, 'connector',   { connectorType: 'system-notify', title: 'CE Full Delivery — P6 Done', message: 'Feature is live. Canary clean. Advance to Phase 7 — Compound.' }, [p6s4c]);

    // ── Phase 7 (y: 5600–6400) ─────────────────────────────────────────
    step(wfId, p7s1, '[P7] CE Compound',             '6-agent compound: extract learnings → docs/solutions/[slug].md.',      300, 6125, 'claude-code', { ...cc('researcher'), prompt: 'Run CE /ce-compound. Canary is clean.\n\nRun 6 parallel tasks:\n- context-analyzer: what problem did this really solve?\n- solution-extractor: what worked / did not work?\n- related-docs-finder: search docs/solutions/ for prior learnings that applied\n- prevention-strategist: how to detect this class of problem earlier?\n- category-classifier: tags for future retrieval (YAML frontmatter)\n- documentation-writer: format the final doc\n\nWRITE docs/solutions/[slug].md with YAML frontmatter and sections: Problem | Solution | What Worked | What Did Not Work | Prevention | Related Docs | Key Code References' }, [p6s5]);
    step(wfId, p7s2, '[P7] Update CLAUDE.md',        'Add new patterns, anti-patterns, taste decisions to CLAUDE.md.',       300, 6300, 'claude-code', { ...cc('planner'), prompt: 'Read the compound doc and git log for this sprint.\n\nUpdate CLAUDE.md — add to relevant sections:\n- NEW PATTERNS: things to repeat\n- ANTI-PATTERNS: things to avoid (include early detection signals)\n- TASTE DECISIONS: naming/structure/approach choices and why\n- CAVEATS: project-specific constraints discovered\n\nRule: if a mistake was made and corrected, document it so it does not repeat.\n\nOutput: sections updated + what was added.' }, [p7s1]);
    step(wfId, p7s3, '[P7] Retro',                   'Run /retro: velocity, coverage trend, blockers → docs/retros/.',       300, 6475, 'claude-code', { ...cc('planner'), prompt: 'Run /retro.\n\n1. VELOCITY: estimated (Phase 1) vs actual\n2. COVERAGE TREND: start vs end\n3. PHASE ANALYSIS: which phase was slowest / smoothest\n4. TOP 3 BLOCKERS\n5. REPEAT: what to do more of\n6. CHANGE: what to do differently\n\nWRITE docs/retros/[today-date]-[slug].md.' }, [p7s2]);
    step(wfId, p7s4, '[P7] Learn & Final Review',    'Run /learn, prune superseded learnings. Final human sign-off.',        300, 6650, 'claude-code', { ...cc('planner'), prompt: 'Run /learn.\n\n1. Review new learnings from this sprint.\n2. Find and deprecate any now-superseded learnings.\n3. Verify CLAUDE.md is consistent.\n\nOutput:\n```\n## Phase 7 — COMPOUND COMPLETE\n\nFeature: [name] is live\nCompound doc: docs/solutions/[slug].md\nCLAUDE.md: [N] patterns added, [N] anti-patterns added\nRetro: docs/retros/[date]-[slug].md\nLearnings: [N] added, [N] superseded\n\nThe system is now smarter than before this feature was built.\n```\n\nDo NOT advance automatically.' }, [p7s3], false);
    step(wfId, p7s5, '[P7] ✓ Sprint Complete',        'All 7 phases done. Feature live, learnings captured.',                300, 6825, 'connector',   { connectorType: 'system-notify', title: 'CE Full Delivery — COMPLETE 🎯', message: 'All 7 phases done. Feature live, compound doc written, CLAUDE.md updated, retro done.' }, [p7s4]);
  }

  console.log('[db] Seeded 20 default workflow templates');
}

seedDefaultTemplates();

export default db;

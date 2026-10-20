import Database, { type Database as DatabaseType } from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { ensureReportStepOnTemplates } from './lib/workflow-report.js';
import { layoutSteps } from './lib/workflow-layout.js';
import { runStandardTemplateSeed } from './lib/templates/index.js';

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

const db: DatabaseType = new Database(DB_PATH, { timeout: 20_000 });

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');

// WAIT for a writer instead of throwing at it.
//
// WAL lets readers and one writer coexist; it does NOT queue two writers. Without a busy
// timeout the second one fails instantly with SQLITE_BUSY "database is locked", and better
// -sqlite3's own default (5s) is not enough when many processes open this file at once and
// each runs the template seed at import.
//
// That is not only a test-suite condition. The runner daemon, a second federated server on
// the same box and the MCP server all open this same file, and a write that throws where it
// could have waited a moment is a lost write with a confusing error attached.

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

// Migration: remember WHY a lane halted.
// Halting for "the cartridge is busy" is transient and must clear itself once the cartridge
// frees — otherwise a spurious halt leaves work parked until a human resumes it, which is the
// exact overnight failure the halt was meant to prevent. A halt from a real dispatch failure
// must NOT self-clear: that needs a person.
try {
  db.prepare('SELECT halt_kind FROM queue_lanes LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE queue_lanes ADD COLUMN halt_kind TEXT NOT NULL DEFAULT ''`);
}

// Migration: hold ONE queue item without holding its lane.
// A column, not a status: `blocked` already means "the system stopped this and a human must
// look", which needs different UI and different recovery from "I parked this deliberately".
try {
  db.prepare('SELECT paused FROM queue_items LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE queue_items ADD COLUMN paused INTEGER NOT NULL DEFAULT 0`);
}

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

// ADX-002 — the addressed inbox. Claude Code binds a per-session Unix socket at
// /tmp/cc-socks/<pid>.sock, and a message posted there is delivered BETWEEN tool
// calls without interrupting the running one. `inbox_pid` is the relay's PTY
// child, which is what names that path.
//
// `inbox_token` is the messaging token. ADX-001 proved the relay cannot READ it
// out of the child — `ps` shows the exec-time environment and claude mints the
// token after exec — so the relay mints one and INJECTS it at spawn, and this is
// where the value it chose is recorded. It is not required for delivery on macOS
// (the 0600 socket and uid ownership are the authentication) and IS required by
// Windows named pipes, so it is stored for parity rather than for today.
//
// INTEGER with a 0 default: 0 means "no inbox known", which is a different and
// honest state from a pid that happens to be free. Nothing may build a socket
// path from 0.
try {
  db.prepare('SELECT inbox_pid FROM agents LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE agents ADD COLUMN inbox_pid INTEGER NOT NULL DEFAULT 0`);
  db.exec(`ALTER TABLE agents ADD COLUMN inbox_token TEXT NOT NULL DEFAULT ''`);
}

// ADX-006 — WHICH transport carried a dispatch, not merely whether one did.
//
// On the row rather than only on the returned Command: that object is handed to
// one caller once, while the row is what everything later reads. It matters most
// for the inbox socket, which resolves asynchronously — there `delivered = 0`
// means "handed over, answer pending" rather than "nothing was listening", and
// only the transport name separates them.
//
// Empty default: rows written before this column existed have no honest answer,
// and '' says so rather than inventing one.
try {
  db.prepare('SELECT transport FROM commands LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE commands ADD COLUMN transport TEXT NOT NULL DEFAULT ''`);
}

/**
 * GAS-014 — which SPEED a turn ran at. Opus fast mode bills $10/$50 per MTok against a
 * standard $5/$25, so without this every fast turn was priced at half its true cost — and an
 * understated burn overstates headroom, which is the direction the usage gauge must never err
 * in. Empty means standard, which is what every row written before this column existed was.
 */
try {
  db.prepare('SELECT speed FROM session_usage LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE session_usage ADD COLUMN speed TEXT NOT NULL DEFAULT ''`);
}

/**
 * GAS-012 — where the usage wall was, and what had been spent when we hit it.
 *
 * Nothing else records this. The badge divides a budget the user typed, and Anthropic
 * publishes no remaining-quota API, so the only way to learn a plan's real ceiling is to
 * notice where it stood each time it was reached. `tokens_at_event` and `cost_usd_at_event`
 * are snapshots taken AT DETECTION and never recomputed: session_usage keeps growing, so the
 * number is unrecoverable a minute later. GAS-013 reads these rows.
 */
try {
  db.prepare('SELECT id FROM limit_events LIMIT 1').get();
} catch {
  db.exec(`CREATE TABLE IF NOT EXISTS limit_events (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    marker TEXT NOT NULL,
    detected_at TEXT NOT NULL,
    tokens_at_event INTEGER NOT NULL DEFAULT 0,
    cost_usd_at_event REAL NOT NULL DEFAULT 0
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_limit_events_at ON limit_events(detected_at)');
}

// Manual subscription calibration: a user says "this provider reached 100% here".
// `weekly_tokens` snapshots the preceding seven days so later usage can be expressed as a
// percentage of a real observed wall rather than a guessed dollar budget.
db.exec(`CREATE TABLE IF NOT EXISTS token_limit_calibrations (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  hit_at TEXT NOT NULL,
  weekly_tokens INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_token_limit_calibrations_provider_at
  ON token_limit_calibrations(provider, hit_at);`);
db.exec('CREATE INDEX IF NOT EXISTS idx_session_usage_agent_recorded ON session_usage(agent_id, recorded_at)');

// Usage checkpoints: the percentage and reset time the PROVIDER displayed, logged by the person
// who saw it. Ground truth from the other side of the meter — see lib/usage-checkpoint.ts.
// `local_tokens` snapshots what the fleet had counted for that provider from the window's start
// to the reading, so two readings measure how many of our tokens make one of their percent.
db.exec(`CREATE TABLE IF NOT EXISTS usage_checkpoints (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  window TEXT NOT NULL DEFAULT 'weekly',
  pct_used REAL NOT NULL,
  resets_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  local_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_checkpoints_provider_observed
  ON usage_checkpoints(provider, window, observed_at);`);

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

  -- The completion report a run produces, brought BACK from the cartridge.
  --
  -- The report step is an ordinary claude-code step: the agent writes workflow-report.json and
  -- .html onto its OWN disk under .neoncore/reports/<runId>/, where the app cannot see them.
  -- "Not sure the reports are working, I haven't seen one yet" — they were, and they were
  -- landing somewhere unreachable. This is where they land now.
  --
  -- Keyed by project as a REPO NAME, matching project_knowledge and the journal routes, so a
  -- report shows up in the same panel you already go to for that repo. UNIQUE on step_id: a
  -- retried report replaces its earlier attempt instead of stacking a second row that disagrees
  -- with the first.
  CREATE TABLE IF NOT EXISTS workflow_reports (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL DEFAULT '',
    workflow_id TEXT NOT NULL,
    step_id TEXT NOT NULL UNIQUE,
    workflow_name TEXT NOT NULL DEFAULT '',
    run_number INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT '',
    report TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_workflow_reports_project ON workflow_reports(project, created_at);

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

  -- Assisted goal authoring. A draft is a PROPOSAL, never a goal.
  --
  -- NeonCore has no LLM client, so drafts are produced the way everything else is: by
  -- dispatching to a cartridge, which submits its answer back through MCP. That keeps the
  -- spend inside session_usage, where goalCostUsd can see it -- a direct API call from the
  -- server would be real money spent against a goal that its own cost rollup could not report.
  --
  -- applied_at is the load-bearing column. It is set ONLY by an explicit user accept, so
  -- "did generated text ever reach a goal without a person choosing it" is answerable from the
  -- row rather than by trusting the code path.
  CREATE TABLE IF NOT EXISTS goal_drafts (
    id TEXT PRIMARY KEY,
    -- NULL while drafting a brand-new goal that does not exist yet.
    goal_id TEXT REFERENCES goals(id) ON DELETE CASCADE,
    seed TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',   -- pending | ready | failed
    agent_id TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',          -- which template/prompt produced it
    fields TEXT NOT NULL DEFAULT '{}',        -- JSON: the proposed values, nothing applied
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    completed_at TEXT,
    applied_at TEXT,
    applied_fields TEXT NOT NULL DEFAULT '[]' -- exactly which keys the user accepted
  );
  CREATE INDEX IF NOT EXISTS idx_goal_drafts_goal ON goal_drafts(goal_id);
  CREATE INDEX IF NOT EXISTS idx_goal_drafts_status ON goal_drafts(status);

  -- Decomposition. Same contract as goal_drafts: a PROPOSAL a person accepts item by item.
  --
  -- Where a draft proposes text for an existing goal, a decomposition proposes new projects and
  -- tasks. Accepting one CREATES rows, so the never-auto-apply rule matters more here, not less:
  -- accepted_at is set only by an explicit per-item accept, and created_projects/created_tasks
  -- record exactly what was made so a bad decomposition is traceable and reversible.
  CREATE TABLE IF NOT EXISTS goal_decompositions (
    id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    seed TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',   -- pending | ready | failed
    agent_id TEXT NOT NULL DEFAULT '',
    proposal TEXT NOT NULL DEFAULT '{}',      -- JSON: normalized projects + tasks, nothing created
    notes TEXT NOT NULL DEFAULT '[]',         -- what validation dropped, so silence is never the report
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    completed_at TEXT,
    accepted_at TEXT,
    created_projects TEXT NOT NULL DEFAULT '[]',
    created_tasks TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX IF NOT EXISTS idx_goal_decompositions_goal ON goal_decompositions(goal_id);

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

// Migration: goals carry INTENT, not just a budget.
//
// The original goal had four authored fields, of which the machinery read exactly one — the
// dollar cap, used to stop work. These are the fields an agent can actually act on, and they
// are plain TEXT because they are written by a person and read by a model: newline-separated
// statements, not a schema to be validated into uselessness. `key_results` is JSON because it
// alone has structure worth querying (metric / baseline / target / how it is measured).
try {
  db.prepare('SELECT acceptance_criteria FROM goals LIMIT 1').get();
} catch {
  db.exec(`
    ALTER TABLE goals ADD COLUMN acceptance_criteria TEXT NOT NULL DEFAULT '';
    ALTER TABLE goals ADD COLUMN no_gos TEXT NOT NULL DEFAULT '';
    ALTER TABLE goals ADD COLUMN rabbit_holes TEXT NOT NULL DEFAULT '';
    ALTER TABLE goals ADD COLUMN invariants TEXT NOT NULL DEFAULT '';
    ALTER TABLE goals ADD COLUMN key_results TEXT NOT NULL DEFAULT '[]';
  `);
  // The old free-text success metric becomes the first acceptance criterion rather than being
  // dropped — it is the only statement of "done" these goals have.
  db.exec(`UPDATE goals SET acceptance_criteria = success_metric WHERE success_metric != ''`);
}


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

export { STANDARD_TEMPLATE_NAMES } from './lib/templates/index.js';


/**
 * Re-seed the standard templates, PRESERVING each one's id.
 *
 * The replace-by-name behaviour is deliberate — it is how template edits in code reach an
 * existing database. What was not deliberate is that every replacement minted a fresh
 * `randomUUID()`, so a template's identity changed on every boot. Under `tsx watch` that is
 * every source save. Consequences were all silent: historical runs' `template_id` became
 * dangling, a dashboard holding an id in its launch modal got 404 "Workflow not found", and
 * anything persisting a template id (heartbeats, scripts) broke.
 *
 * So the id is captured before the delete and reused on the insert. Content is still fully
 * refreshed; only identity survives.
 */
export function seedDefaultTemplates() {
  // ONE TRANSACTION, and it is not a nicety.
  //
  // This deletes every standard template and re-inserts it, at module load, on every boot. The
  // server's test suite has 60-plus files that do NOT point at an isolated database, so they
  // open the real one concurrently and each runs this. Between one process's workflow INSERT
  // and its step INSERTs, another process's DELETE lands — and the step insert dies on
  // SQLITE_CONSTRAINT_FOREIGNKEY, taking the whole test FILE with it. Different file each run,
  // no named failing test, and reproducible on a clean tree: 2 of 6 runs before this, and
  // closer to every run once three more test files were added.
  //
  // A half-applied seed is also not a state worth exposing to a reader even when it does not
  // crash: all of the templates or none.
  //
  // IMMEDIATE, not the default DEFERRED. A deferred transaction starts as a READER and upgrades
  // when it first writes — and SQLite refuses to apply `busy_timeout` to that upgrade, because
  // waiting there could deadlock two readers each trying to become the writer. It returns
  // SQLITE_BUSY at once instead, so the timeout above looked like it did nothing. IMMEDIATE
  // takes the write lock up front, which is exactly the case the timeout is for.
  db.transaction(() => runStandardTemplateSeed(db)).immediate();
}


/**
 * N4 autonomy: what a run was allowed to resolve for itself, and what it chose.
 *
 * "The audit table is not optional. The first time a `full` run picks something you disagree
 * with, the only useful question is what it chose and on what basis." (docs/plans/build-order.md)
 *
 * `autonomy` records the level IN FORCE AT THE TIME, not the level now — a run whose posture
 * was raised for two hours and then lapsed must still show why it advanced itself at 3am.
 * `overridden` is set when a person reverses the decision afterwards, which is the signal that
 * a level is granting more latitude than it should.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS workflow_auto_resolutions (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    chose TEXT NOT NULL,
    autonomy TEXT NOT NULL,
    overridden INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_auto_res_workflow ON workflow_auto_resolutions(workflow_id);
  CREATE INDEX IF NOT EXISTS idx_auto_res_created ON workflow_auto_resolutions(created_at);
`);

/**
 * Migration: decomposition provenance and task dependencies (GOAL-041/044).
 *
 * `origin_decomposition_id` answers "which run proposed this, and did a person accept it" for
 * every generated row — the difference between a traceable decomposition and a pile of tasks
 * nobody can attribute.
 *
 * `depends_on` exists because the proposal format carries dependencies and discarding them at
 * accept time would throw away something the user reviewed. Nothing ENFORCES ordering yet
 * (that is Phase 6), so it would be an inert column — except that acceptance derives each
 * task's `priority` from its dependency depth, which makes the queue respect the order today.
 */
for (const [table, column, decl] of [
  ['tasks', 'depends_on', "TEXT NOT NULL DEFAULT '[]'"],
  // A SHORT human subject for a run, so a list can name it without a uuid. The column existed on
  // one developer machine and in NO migration — added by code since removed, so a fresh install
  // (a teammate, CI, a new box) lacked it entirely. Building the label feature on it would have
  // worked here and broken everywhere else; the set-based test caught that before it shipped.
  ['workflows', 'context_label', "TEXT NOT NULL DEFAULT ''"],
  // Which cartridge SESSION a step's prompt was dispatched into. `delivered` only means the
  // relay socket accepted the emit; if the engine had not attached yet, the prompt is lost and
  // every last_seen-based check still reads the cartridge as healthy. Comparing this against
  // the cartridge's current session is the one fact that exposes it. See step-session-guard.ts.
  ['workflow_steps', 'dispatch_session_id', "TEXT NOT NULL DEFAULT ''"],
  // Which cartridge that prompt went to. A review gate can dispatch to `reviewAgentId`, not
  // `executor_id`; judging (and re-sending to) the executor watched the wrong session.
  ['workflow_steps', 'dispatch_agent_id', "TEXT NOT NULL DEFAULT ''"],
  // Which budget alert has already fired for this goal. Persisted rather than held in memory
  // because tsx watch restarts the server on every source save, and an in-memory guard would
  // re-fire the same warning several times an hour while someone edits the code.
  ['goals', 'budget_alert_state', "TEXT NOT NULL DEFAULT 'ok'"],
  // PM surface (Phase 7). All four default to empty, and empty means UNSET rather than a
  // default value: an autonomy posture nobody chose must not silently grant latitude, and a
  // goal with no target date is not "on time", it has no schedule.
  ['goals', 'target_date', "TEXT NOT NULL DEFAULT ''"],
  ['goals', 'owner', "TEXT NOT NULL DEFAULT ''"],
  ['goals', 'investment_category', "TEXT NOT NULL DEFAULT ''"],
  ['goals', 'autonomy', "TEXT NOT NULL DEFAULT ''"],
  ['tasks', 'origin_decomposition_id', 'TEXT'],
  ['projects', 'origin_decomposition_id', 'TEXT'],

  // N4 autonomy (docs/plans/build-order.md). 'manual' is the default because a posture nobody
  // chose must not grant latitude — the same reasoning as `goals.autonomy` above, which uses
  // '' for unset. Here the plan specifies a literal default, and 'manual' IS the safe one.
  //
  // `autonomy_expires_at` is what makes raising a level a decision you cannot forget you made:
  // an unbounded grant is one you stop noticing.
  // A scheduled run fires with NOBODY WATCHING, so 'manual' — which auto-resolves nothing —
  // is the one posture that cannot be right for it. Same default as a hand-launched run
  // (DEFAULT_AUTONOMY): a schedule is a launch you are not present for, not a weaker one.
  ['heartbeats', 'autonomy', "TEXT NOT NULL DEFAULT 'full'"],
  // What was typed into the launch form. A scheduled run that drops it is not the run that
  // was configured — the form collects context, and scheduling is just "run this later".
  ['heartbeats', 'initial_context', "TEXT NOT NULL DEFAULT ''"],
  // Where the rendered HTML lives on the cartridge's disk. Without it the journal holds the
  // JSON and no way to open the half a person actually reads — and a browser will not follow a
  // file:// link from an http page, so the server has to serve it.
  ['workflow_reports', 'html_path', "TEXT NOT NULL DEFAULT ''"],
  ['workflows', 'autonomy', "TEXT NOT NULL DEFAULT 'manual'"],
  ['workflows', 'autonomy_expires_at', 'TEXT'],
  ['projects', 'default_autonomy', "TEXT NOT NULL DEFAULT 'manual'"],
] as const) {
  try {
    db.prepare(`SELECT ${column} FROM ${table} LIMIT 1`).get();
  } catch {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

seedDefaultTemplates();

// Every template ends in a Workflow Completion Report — the standard ones just re-seeded
// above AND the ones a user built on the canvas, which is why this keys off `template_id IS
// NULL` rather than a list of names. It has to run AFTER seedDefaultTemplates(), which
// deletes and re-inserts the standard templates on every boot and would otherwise drop the
// step this just wrote. Idempotent: a template that already carries the marker is skipped.
/**
 * RECONNECT HISTORICAL RUNS TO THEIR TEMPLATE.
 *
 * `stableId` preserves a template's id across re-seeds now, but it did not always: every boot
 * used to mint a fresh `randomUUID()`, and the comment on seedDefaultTemplates records the
 * consequence — "historical runs' template_id became dangling". Measured on the live database:
 * 71 runs going back to April 2026, and 70 of them pointing at a template id that no longer
 * existed.
 *
 * That is not cosmetic. `GET /workflows/:id/runs` and the dashboard's run history both join on
 * this column, so eight months of runs were invisible from the template that produced them —
 * and any count taken over the join reads as zero, which is exactly the wrong conclusion to
 * draw about a template.
 *
 * Matched BY NAME, which is the same key seedDefaultTemplates uses to preserve identity in the
 * first place, and only for runs whose current template_id resolves to nothing. A run already
 * pointing at a live template is never touched.
 */
function reattachOrphanedRuns(): number {
  const changed = db.prepare(`
    UPDATE workflows AS r
       SET template_id = (
             SELECT t.id FROM workflows t
              WHERE t.template_id IS NULL AND t.name = r.name
              ORDER BY t.created_at ASC LIMIT 1)
     WHERE r.template_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM workflows t2 WHERE t2.id = r.template_id)
       AND EXISTS (SELECT 1 FROM workflows t3 WHERE t3.template_id IS NULL AND t3.name = r.name)
  `).run().changes;
  return changed;
}

const reattached = reattachOrphanedRuns();
if (reattached > 0) {
  console.log(`[db] Re-attached ${reattached} historical run(s) to their template`);
}

const reportStepsAdded = ensureReportStepOnTemplates(db);

// Lay every template out with ONE spacing, recomputed from the step graph.
//
// The y values in the template definitions above are ~150 hand-typed literals stepping by 175,
// which crowds a 300px-wide node — "all the steps are close together". Rather than edit every
// literal (and have the next template type a new one), the layout is recomputed here from the
// dependency graph. The authored values no longer matter.
for (const t of db.prepare('SELECT id FROM workflows WHERE template_id IS NULL').all() as { id: string }[]) {
  layoutSteps(db, t.id);
}
if (reportStepsAdded > 0) {
  console.log(`[db] Added the completion report step to ${reportStepsAdded} workflow template(s)`);
}

export default db;

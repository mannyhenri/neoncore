# NeonCore — Testing Guide

How to test the features added in the transcript-pipeline + MCP-coordination work:

1. **Rich transcript pipeline** — full Claude/Gridlight output (text, thinking, tool I/O) + token usage captured into NeonCore
2. **Hook consolidation** — `Stop` now flows through the reporter; token tracking fixed
3. **Gridlight extension** — displays Claude sessions + unifies its own into the pipeline
4. **MCP coordination server** — `report_step_done` + agent task-queue tools
5. **Task queue** — REST + MCP + dashboard UI
6. **Workflow step-gating** — MCP-first completion with fallbacks

Everything here runs on your Claude subscription — **no Anthropic API key required.**

---

## 0. Setup

```bash
cd server
npm run build          # compiles server + dist/mcp-server.js
npm run dev            # tsx watch on :4040 (auto-reloads). Leave running.
# (or: npm start  to run the built dist/)
```

Build the dashboard (served from `server/public`):
```bash
cd dashboard && npm run build      # tsc -b && vite build
```

Confirm the server is up:
```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4040/api/agents   # expect 200
```

Handy env for the snippets below:
```bash
B=http://localhost:4040
DB=server/neoncore.db          # run node snippets from the server/ dir
TSTATE_DIR=$(python3 -c "import tempfile;print(tempfile.gettempdir())")   # where hook offset files live (NOT /tmp on macOS)
```

> **DB query helper** (run from `server/`): `node -e "const d=require('better-sqlite3')('./neoncore.db',{readonly:true}); console.log(d.prepare('<SQL>').all())"`

---

## 1. Rich transcript pipeline (items 1–3)

**Goal:** every turn of a Claude Code session lands in the `messages` table with full content blocks + token usage, and streams over `transcript_event`.

### 1a. Live test (real session)
1. Make sure the hooks are installed (`~/.claude/settings.json` has NeonCore entries for PreToolUse / PostToolUse / UserPromptSubmit / Stop / Notification / SubagentStop / **SessionEnd**). If not: `cd agent && python3 install.py`.
2. In any repo, run a normal Claude Code session — ask it to read a file and make an edit.
3. Inspect what landed (run from `server/`):
```bash
node -e "const d=require('better-sqlite3')('./neoncore.db',{readonly:true});
const r=d.prepare('SELECT role,COUNT(*) n FROM messages GROUP BY role').all();
console.log('by role:', r);
const last=d.prepare('SELECT seq,role,model,input_tokens,output_tokens FROM messages ORDER BY rowid DESC LIMIT 3').all();
console.log('latest:', last);"
```
**Expect:** assistant + user rows; assistant rows carry a `model` and non-zero `input_tokens`/`output_tokens`. Content blocks (text / tool_use / tool_result, and thinking when present as plaintext) are in the `content` JSON column.

### 1b. Synthetic test (no live session needed)
```bash
SID="t-$($(echo date) +%s 2>/dev/null || echo $RANDOM)"
curl -s -X POST $B/api/agents/register -H 'Content-Type: application/json' \
  -d "{\"machine\":\"testbox\",\"repoPath\":\"/tmp/tr\",\"repoName\":\"tr\",\"sessionId\":\"$SID\",\"agentType\":\"claude\"}" >/dev/null
curl -s -X POST $B/api/agents/transcript -H 'Content-Type: application/json' -d "{
  \"sessionId\":\"$SID\",\"machine\":\"testbox\",\"repoPath\":\"/tmp/tr\",\"engine\":\"claude\",\"triggeredBy\":\"Stop\",
  \"events\":[
    {\"seq\":1,\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"fix the bug\"}]},
    {\"seq\":2,\"role\":\"assistant\",\"model\":\"claude-opus-4-8\",
     \"content\":[{\"type\":\"thinking\",\"text\":\"thinking...\"},{\"type\":\"text\",\"text\":\"On it.\"},{\"type\":\"tool_use\",\"name\":\"Read\",\"id\":\"t1\",\"input\":\"{}\"}],
     \"usage\":{\"input_tokens\":1200,\"output_tokens\":340,\"cache_read_input_tokens\":5000,\"cache_creation_input_tokens\":200}}
  ]}"
echo "  ^ expect {\"inserted\":2}"
# Idempotency: re-POST the same seqs → inserted:0
curl -s -X POST $B/api/agents/transcript -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"$SID\",\"machine\":\"testbox\",\"repoPath\":\"/tmp/tr\",\"events\":[{\"seq\":1,\"role\":\"user\",\"content\":[]},{\"seq\":2,\"role\":\"assistant\",\"content\":[]}]}"
echo "  ^ expect {\"inserted\":0}  (idempotent on session_id+seq)"
```

### 1c. Incremental offset (only new lines ship)
The reporter hook tracks a per-session byte offset so each firing ships only new transcript lines.
```bash
ls "$TSTATE_DIR"/neoncore-tstate-* 2>/dev/null   # one file per active session: {"offset":N,"seq":M}
```
**Expect:** a state file whose `offset` advances as the session grows. Re-running a hook with an unchanged transcript ships nothing new.

---

## 2. Token tracking (the previously-broken bit)

```bash
node -e "const d=require('better-sqlite3')('./neoncore.db',{readonly:true});
console.log(d.prepare('SELECT COUNT(*) rows, SUM(input_tokens) inp, SUM(output_tokens) outp FROM session_usage').get());"
```
**Expect:** non-zero rows and token sums (previously this table was near-empty because usage was read from the hook stdin, which rarely carried it). Per-agent totals: `GET /api/activity/usage/<agentId>`.

---

## 3. Hook consolidation (Stop → reporter)

```bash
python3 -c "import json;d=json.load(open('$HOME/.claude/settings.json'));print('Stop →', d['hooks']['Stop'][0]['hooks'][0]['command'])"
```
**Expect:** the `Stop` command points at **`reporter.py`** (the Python installer wires all events to `reporter.py` / `permission-proxy.py` / `notification.py`; the `.sh` scripts are legacy). After a real turn ends, the final assistant message + final usage appear in `messages` / `session_usage`.

---

## 4. VS Code extension (manual — needs VS Code)

Rebuild + reload first:
```bash
npm run extension:package     # builds extension/ ; then reload the VS Code window
```
- **Config keys:** the extension exposes `neoncore.orchestratorUrl`, `neoncore.autoConnect`, and `neoncore.agentType` (no `gridlight.*` keys). Point `neoncore.orchestratorUrl` at the server and connect via the status-bar item.
- **Display:** with the extension connected, run a Claude Code session in another window — its turns should appear read-only in the panel (text/thinking/tool blocks + a per-turn token line).
- **Unify:** confirm transcript rows appear in `messages` (Claude sessions use `engine='claude'`; Gridlight sessions use `engine='gridlight'`):
```bash
node -e "const d=require('better-sqlite3')('./neoncore.db',{readonly:true});console.log(d.prepare(\"SELECT COUNT(*) n FROM messages WHERE engine='gridlight'\").get());"
```

---

## 5. MCP coordination server

The MCP server is `server/dist/mcp-server.js` (stdio). It exposes 8 tools.

### 5a. Smoke test (lists + round-trips tools)
Run from `server/` (so it resolves the SDK from `node_modules`):
```bash
cat > ./_mcp_smoke.mjs <<'EOF'
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const transport = new StdioClientTransport({
  command: 'node', args: [process.cwd() + '/dist/mcp-server.js'],
  env: { ...process.env, NEONCORE_URL: 'http://localhost:4040', NEONCORE_AGENT_TYPE: 'claude' },
});
const c = new Client({ name: 'smoke', version: '1.0' }, { capabilities: {} });
await c.connect(transport);
console.log('tools:', (await c.listTools()).tools.map(t => t.name));
console.log((await c.callTool({ name: 'neoncore_list_agents', arguments: { sessionId: 'smoke' } })).content[0].text.split('\n')[0]);
await c.close(); process.exit(0);
EOF
node ./_mcp_smoke.mjs; rm -f ./_mcp_smoke.mjs
```
**Expect:** 8 tools listed — `neoncore_register`, `neoncore_report`, `neoncore_request_permission`, `neoncore_report_step_done`, `neoncore_my_queue`, `neoncore_claim_task`, `neoncore_report_task_done`, `neoncore_list_agents` — and a "Agents known to NeonCore (N)" line.

### 5b. In Claude Code
```bash
cd agent && python3 install.py     # writes .mcp.json + prints the global `claude mcp add-json … --scope user` command
```
Restart Claude Code in the project, then run `/mcp` — **expect** a `neoncore` server with the tools listed and approvable.

---

## 6. Task queue (REST + MCP + UI)

### 6a. REST lifecycle + atomicity
```bash
SID="q-$RANDOM"
AID=$(curl -s -X POST $B/api/agents/register -H 'Content-Type: application/json' -d "{\"machine\":\"qbox\",\"repoPath\":\"/tmp/q\",\"repoName\":\"q\",\"sessionId\":\"$SID\",\"agentType\":\"claude\"}" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
TID=$(curl -s -X POST $B/api/tasks -H 'Content-Type: application/json' -d '{"title":"Fix login","prompt":"investigate 500","priority":5}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s "$B/api/tasks/queue?sessionId=$SID" | python3 -c "import json,sys;print('queue:',[t['title'] for t in json.load(sys.stdin)])"
curl -s -o /dev/null -w "claim #1: %{http_code} (expect 200)\n" -X POST $B/api/tasks/$TID/claim -H 'Content-Type: application/json' -d "{\"sessionId\":\"$SID\"}"

# second agent tries to claim the same task → must fail atomically
curl -s -X POST $B/api/agents/register -H 'Content-Type: application/json' -d "{\"machine\":\"qbox2\",\"repoPath\":\"/tmp/q2\",\"repoName\":\"q2\",\"sessionId\":\"$SID-x\",\"agentType\":\"claude\"}" >/dev/null
curl -s -o /dev/null -w "claim #2: %{http_code} (expect 409)\n" -X POST $B/api/tasks/$TID/claim -H 'Content-Type: application/json' -d "{\"sessionId\":\"$SID-x\"}"

curl -s -o /dev/null -w "start: %{http_code} (expect 200)\n" -X POST $B/api/tasks/$TID/start -H 'Content-Type: application/json' -d "{\"sessionId\":\"$SID\"}"
curl -s -X POST $B/api/tasks/$TID/complete -H 'Content-Type: application/json' -d "{\"sessionId\":\"$SID\",\"result\":\"patched\",\"status\":\"done\"}" | python3 -c "import json,sys;print('final:',json.load(sys.stdin)['status'])"
curl -s -o /dev/null -w "non-owner complete: %{http_code} (expect 403)\n" -X POST $B/api/tasks/$TID/complete -H 'Content-Type: application/json' -d "{\"sessionId\":\"$SID-x\",\"result\":\"x\"}"
```
**Expect:** queue shows the task → claim #1 = 200 → claim #2 = **409** → start = 200 → complete = `done` → non-owner = **403**.

### 6b. Via MCP (agent's view)
Using the smoke client from §5a, call `neoncore_my_queue`, then `neoncore_claim_task`, then `neoncore_report_task_done` with a registered agent's `sessionId`.

### 6c. Dashboard UI
1. Open the dashboard (`http://localhost:4040`), click the **Tasks** tab.
2. Click **New task**, fill title/prompt/priority, create.
3. **Expect:** it appears instantly (no refresh) with a "Queued" badge; the Tasks nav shows an active-count badge.
4. In a second browser tab, create another task → it should appear live in the first (socket `task_created`).
5. Run the §6a claim/complete flow → the card's badge updates live to Claimed → Done (socket `task_updated`).
6. Click **Cancel** on a queued task → badge flips to Cancelled.

---

## 7. Workflow step-gating (MCP-first completion)

1. Launch a V2 workflow from the dashboard with a `claude-code` step dispatched to an agent.
2. Inspect the dispatched prompt — it should instruct calling **`neoncore_report_step_done`** (with `step_id=…`) as the primary completion signal, with the `curl` webhook as fallback:
```bash
node -e "const d=require('better-sqlite3')('./neoncore.db',{readonly:true});const s=d.prepare(\"SELECT name,dispatched_prompt FROM workflow_steps WHERE status='running' ORDER BY started_at DESC LIMIT 1\").get();console.log(s? s.dispatched_prompt.slice(-400):'no running step');"
```
3. **Happy path:** the agent calls `neoncore_report_step_done` → the step flips to `completed` and the workflow advances.
4. **Fallback paths (regression):** if the tool isn't called, the `curl` webhook (`POST /api/workflows/webhook/<stepId>/complete`) still completes it, and the 60s idle-detection backstop still force-completes — so workflows never hang.

---

## 8. One-shot smoke (everything quick)

From `server/` with the server running:
```bash
B=http://localhost:4040
echo "transcript endpoint:"; curl -s -o /dev/null -w "  %{http_code} (expect 404 = live handler, agent-not-found)\n" -X POST $B/api/tasks/queue # n/a
curl -s -o /dev/null -w "tasks list: %{http_code} (expect 200)\n" $B/api/tasks
curl -s -o /dev/null -w "agents:     %{http_code} (expect 200)\n" $B/api/agents
node -e "const d=require('better-sqlite3')('./neoncore.db',{readonly:true});
for (const t of ['messages','session_usage','tasks']) console.log(t+':', d.prepare('SELECT COUNT(*) n FROM '+t).get().n, 'rows');"
```

---

## 9. Cleanup test data

```bash
cd server && node -e "
const d=require('better-sqlite3')('./neoncore.db'); d.pragma('foreign_keys=OFF');
d.prepare(\"DELETE FROM messages WHERE session_id LIKE 't-%' OR session_id LIKE 'q-%'\").run();
d.prepare(\"DELETE FROM session_usage WHERE session_id LIKE 't-%' OR session_id LIKE 'q-%'\").run();
d.prepare(\"DELETE FROM tasks WHERE title IN ('Fix login','UI smoke task')\").run();
const cols=['activity','session_usage','messages','permissions','commands','agent_memory','notes','sessions','heartbeats','tasks'];
for (const a of d.prepare(\"SELECT id FROM agents WHERE machine IN ('testbox','qbox','qbox2')\").all()){
  for (const c of cols) try{ d.prepare('DELETE FROM '+c+' WHERE agent_id=?').run(a.id);}catch(e){}
  d.prepare('DELETE FROM agents WHERE id=?').run(a.id);
}
console.log('cleaned test data');"
# also remove stray hook offset files for synthetic sessions:
rm -f "$(python3 -c 'import tempfile;print(tempfile.gettempdir())')"/neoncore-tstate-t-* 2>/dev/null
```

---

## Expected-results cheat sheet

| Test | Pass criteria |
|---|---|
| Transcript ingest | `inserted:N` then `inserted:0` on replay |
| Token tracking | `session_usage` has non-zero token sums |
| Stop hook | settings `Stop` → `reporter.sh` |
| MCP tools | 8 tools listed via smoke client |
| Task claim | claim #1 = 200, claim #2 = **409** |
| Task ownership | non-owner complete = **403** |
| Task UI | live create/update without refresh |
| Workflow gating | running step's prompt mentions `neoncore_report_step_done` |

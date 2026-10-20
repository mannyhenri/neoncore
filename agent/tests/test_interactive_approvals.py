"""
A DECISION MADE IN NEONCORE MUST LAND IN THE TERMINAL.

THE BUG. Approving a plan (ExitPlanMode) or answering a question (AskUserQuestion) in the
dashboard or on the phone still left Claude Code's own dialog up in the terminal, so the human
had to do it twice — and choices made in the app never reached the agent. Claude Code's hooks
reference says why: "`allow` skips the permission prompt, except ... for `AskUserQuestion` and
`ExitPlanMode`, which need `updatedInput` paired with it." The Python hook sent a bare allow
for plans; the shell hook did the same, and for questions it DENIED the tool with the answers
in prose; and neither understood the approvals inbox's `{response: "..."}` payload, so those
answers were dropped on the floor.

WHY IT IS SET-BASED. Three sets multiply here, and a fix that covers one cell passes an
example test: both hook variants (install.py wires the .py, install.sh wires the .sh), every
interactive tool (INTERACTIVE_TOOLS, the hook's own registry), and every payload key a UI
surface sends with an approval — which is READ FROM THE UI SOURCE, so a new surface that
invents a new key fails here the day it is added rather than in someone's terminal.

The hooks are run as real subprocesses against a stub NeonCore, so what is asserted is the
exact JSON Claude Code reads on stdout.

Run from the repo root:  python3 agent/tests/test_interactive_approvals.py
"""
import glob
import importlib.util
import json
import os
import re
import subprocess
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
HOOKS = os.path.join(ROOT, "agent", "hooks")
sys.path.insert(0, HOOKS)
_spec = importlib.util.spec_from_file_location("permission_proxy", os.path.join(HOOKS, "permission-proxy.py"))
proxy = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(proxy)

HOOK_COMMANDS = {
    "permission-proxy.py": [sys.executable, os.path.join(HOOKS, "permission-proxy.py")],
    "permission-proxy.sh": ["bash", os.path.join(HOOKS, "permission-proxy.sh")],
}

QUESTION_INPUT = {
    "questions": [{
        "question": "Which database should we use?",
        "header": "Database",
        "multiSelect": False,
        "options": [{"label": "Postgres", "description": "relational"}, {"label": "SQLite", "description": "embedded"}],
    }],
}
PLAN_INPUT = {"plan": "1. Do the thing\n2. Verify the thing", "allowedPrompts": [{"tool": "Bash", "prompt": "run tests"}]}
ANSWER = "Postgres"


def ui_approval_payload_keys() -> set[str]:
    """Every top-level key a dashboard/mobile surface sends alongside an 'allowed' decision."""
    keys: set[str] = set()
    pattern = re.compile(r"'allowed',\s*(?:\w+\s*\?\s*)?\{\s*(\w+)")
    for path in glob.glob(os.path.join(ROOT, "dashboard", "src", "**", "*.tsx"), recursive=True) + \
            glob.glob(os.path.join(ROOT, "mobile", "src", "**", "*.tsx"), recursive=True):
        with open(path, encoding="utf-8") as fh:
            keys.update(pattern.findall(fh.read()))
    return keys


def response_for(key: str) -> dict:
    """The payload a UI sends under `key` when the human picks ANSWER."""
    if key == "answers":
        return {"answers": {"Which database should we use?": ANSWER}}
    return {key: ANSWER}  # free-text forms: `response` (approvals inbox), `result` (legacy UI)


class StubNeonCore:
    """Answers the four endpoints the hooks call; the poll returns the scripted decision."""

    def __init__(self, decision: str, response: str, trust: bool = False):
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def _json(self, body):
                data = json.dumps(body).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                if self.path.startswith("/api/permissions/request"):
                    return self._json({"id": "perm-1", "trustMode": stub.trust})
                return self._json({"id": "agent-1", "ok": True})

            def do_GET(self):
                if self.path.startswith("/api/permissions/poll/"):
                    return self._json({"decision": stub.decision, "response": stub.response})
                return self._json({})

        self.decision, self.response, self.trust = decision, response, trust
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()


def run_hook(hook: str, tool_name: str, tool_input: dict, decision: str, response: str,
             trust: bool = False) -> dict:
    stub = StubNeonCore(decision, response, trust)
    try:
        env = {**os.environ, "NEONCORE_URL": stub.url, "NEONCORE_FLEET_TOKEN": "test"}
        env.pop("NEONCORE_TRUST", None)
        payload = {"session_id": "approval-test", "tool_name": tool_name, "tool_input": tool_input, "cwd": ROOT}
        out = subprocess.run(HOOK_COMMANDS[hook], input=json.dumps(payload), capture_output=True,
                             text=True, env=env, timeout=30).stdout.strip()
        return json.loads(out.splitlines()[-1]) if out else {}
    finally:
        stub.close()


class DecisionsReachTheTerminal(unittest.TestCase):
    def test_registry_covers_claude_codes_interactive_tools(self):
        self.assertEqual(set(proxy.INTERACTIVE_TOOLS), {"AskUserQuestion", "ExitPlanMode"})

    def test_every_ui_payload_key_is_understood(self):
        keys = ui_approval_payload_keys()
        self.assertTrue({"answers", "response"} <= keys, keys)  # the scan itself must work

    def test_approval_carries_updated_input_for_every_hook_tool_and_payload(self):
        payload_keys = sorted(ui_approval_payload_keys() | {"result"})
        cases = []
        for hook in HOOK_COMMANDS:
            for tool in proxy.INTERACTIVE_TOOLS:
                if tool == "ExitPlanMode":
                    cases.append((hook, tool, PLAN_INPUT, ""))  # plan cards approve with no payload
                else:
                    cases += [(hook, tool, QUESTION_INPUT, json.dumps(response_for(k))) for k in payload_keys]
        for hook, tool, tool_input, response in cases:
            with self.subTest(hook=hook, tool=tool, response=response):
                out = run_hook(hook, tool, tool_input, "allowed", response).get("hookSpecificOutput", {})
                self.assertEqual(out.get("permissionDecision"), "allow", out)
                updated = out.get("updatedInput")
                self.assertIsInstance(updated, dict, f"bare allow — Claude Code will still prompt: {out}")
                for field, value in tool_input.items():  # updatedInput REPLACES the input
                    self.assertEqual(updated.get(field), value)
                if tool == "AskUserQuestion":
                    self.assertEqual(updated.get("answers"), {"Which database should we use?": ANSWER})

    def test_trust_mode_never_sends_a_bare_allow_for_an_interactive_tool(self):
        # Trust mode auto-approves ordinary tools, but a bare allow for these leaves the
        # terminal dialog up — so they must still go to the human in NeonCore.
        for hook in HOOK_COMMANDS:
            for tool in proxy.INTERACTIVE_TOOLS:
                with self.subTest(hook=hook, tool=tool):
                    tool_input = PLAN_INPUT if tool == "ExitPlanMode" else QUESTION_INPUT
                    response = "" if tool == "ExitPlanMode" else json.dumps(response_for("answers"))
                    out = run_hook(hook, tool, tool_input, "allowed", response, trust=True)
                    hso = out.get("hookSpecificOutput", {})
                    self.assertNotIn("trust mode", hso.get("permissionDecisionReason", ""), hso)
                    self.assertIn("updatedInput", hso, hso)

    def test_plan_rejection_feedback_reaches_claude_from_both_hooks(self):
        for hook in HOOK_COMMANDS:
            with self.subTest(hook=hook):
                out = run_hook(hook, "ExitPlanMode", PLAN_INPUT, "denied",
                               json.dumps({"feedback": "split step 2"})).get("hookSpecificOutput", {})
                self.assertEqual(out.get("permissionDecision"), "deny")
                self.assertIn("split step 2", out.get("permissionDecisionReason", ""))


if __name__ == "__main__":
    unittest.main(verbosity=2)

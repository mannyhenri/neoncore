"""A Claude PostToolUse payload's tool output reaches the activity feed.

Claude Code sends the tool's output as `tool_response`; reporter.py read `tool_result`, so
every Claude activity row stored `{}`. codex-reporter.py already read `tool_response` first.
"""
import importlib.util, io, json, sys, tempfile, unittest

sys.path.insert(0, 'agent/hooks')
spec = importlib.util.spec_from_file_location('reporter', 'agent/hooks/reporter.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def run_hook(payload):
    posted = []
    m.post_json = lambda url, body, retries=3: posted.append((url, json.loads(body))) or True
    sys.stdin = io.StringIO(json.dumps(payload))
    try:
        m.main()
    except SystemExit:
        pass
    return [b for u, b in posted if u.endswith('/api/activity')]


class ToolResponseReported(unittest.TestCase):
    def base(self, **extra):
        return {'session_id': 's1', 'cwd': tempfile.mkdtemp(), 'hook_event_name': 'PostToolUse',
                'tool_name': 'Bash', 'tool_input': {'command': 'ls'}, **extra}

    def test_tool_response_is_sent(self):
        [activity] = run_hook(self.base(tool_response={'stdout': 'a.txt\nb.txt', 'stderr': ''}))
        self.assertEqual(activity['toolResult'], {'stdout': 'a.txt\nb.txt', 'stderr': ''})

    def test_legacy_tool_result_still_works(self):
        [activity] = run_hook(self.base(tool_result={'stdout': 'x'}))
        self.assertEqual(activity['toolResult'], {'stdout': 'x'})

    def test_large_responses_are_truncated(self):
        [activity] = run_hook(self.base(tool_response={'stdout': 'y' * 20000}))
        self.assertTrue(activity['toolResult']['result'].endswith('...truncated'))
        self.assertLess(len(activity['toolResult']['result']), 8100)


unittest.main()

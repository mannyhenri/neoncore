"""A context compaction in the transcript reaches the server as `compacted: true`.

NeonCore sends later workflow steps shorter prompts when their session already holds what they
would repeat (server/src/lib/session-ledger.ts). After Claude Code compacts, it no longer does;
the server learns of the compaction from the transcript events this reporter ships. Both shapes
Claude Code writes are covered: the `compact_boundary` system line and the `isCompactSummary`
user message. Ordinary lines must stay unflagged.
"""
import importlib.util, json, os, sys, tempfile, unittest

sys.path.insert(0, 'agent/hooks')
spec = importlib.util.spec_from_file_location('reporter', 'agent/hooks/reporter.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class CompactionReported(unittest.TestCase):
    def test_boundary_line_is_a_flagged_system_event(self):
        ev = m.normalize_entry({'type': 'system', 'subtype': 'compact_boundary', 'content': 'Conversation compacted'}, 7)
        self.assertEqual(ev, {'seq': 7, 'role': 'system', 'content': [], 'compacted': True})

    def test_summary_message_is_flagged_and_kept(self):
        ev = m.normalize_entry({'type': 'user', 'isCompactSummary': True,
                                'message': {'role': 'user', 'content': 'This session is being continued…'}}, 8)
        self.assertTrue(ev['compacted'])
        self.assertEqual(ev['role'], 'user')
        self.assertEqual(ev['content'][0]['text'], 'This session is being continued…')

    def test_ordinary_lines_are_not_flagged(self):
        for entry in ({'type': 'user', 'message': {'role': 'user', 'content': 'hello'}},
                      {'type': 'assistant', 'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': 'hi'}]}}):
            ev = m.normalize_entry(entry, 1)
            self.assertNotIn('compacted', ev)
        self.assertIsNone(m.normalize_entry({'type': 'system', 'subtype': 'other'}, 2))

    def test_a_transcript_with_a_compaction_ships_the_flag(self):
        lines = [
            {'type': 'user', 'message': {'role': 'user', 'content': 'step one'}},
            {'type': 'system', 'subtype': 'compact_boundary', 'content': 'Conversation compacted'},
            {'type': 'user', 'isCompactSummary': True, 'message': {'role': 'user', 'content': 'summary'}},
        ]
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, 't.jsonl')
            with open(path, 'w') as f:
                f.write(''.join(json.dumps(l) + '\n' for l in lines))
            m.load_transcript_state = lambda sid: (0, 0)
            events, _, _ = m.extract_new_transcript_events(path, 'compaction-test')
        self.assertEqual([e.get('compacted', False) for e in events], [False, True, True])


unittest.main()

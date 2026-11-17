"""The Stop gate reads only THIS turn's assistant text.

`last_assistant_text` used to collect the last 6 assistant messages without stopping at the
prompt that started the turn. A short follow-up turn ("add a note, no report") therefore
carried the previous turn's NEONCORE-DONE block into the completion check, and the gate let
an unreported turn end. Tool results are user-role entries too; they are part of the turn and
must not end the scan. Claude Code's Stop payload carries `last_assistant_message`, which is
used when the transcript has not caught up yet.
"""
import importlib.util, json, os, sys, tempfile, unittest

sys.path.insert(0, 'agent/hooks')
spec = importlib.util.spec_from_file_location('reporter', 'agent/hooks/reporter.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

REPORT = 'Done.\n\nNEONCORE-DONE\nscope: 1 file\nverify: npm test — 12 passed\n'


def user(text):
    return {'type': 'user', 'message': {'role': 'user', 'content': text}}


def tool_result():
    return {'type': 'user', 'message': {'role': 'user', 'content': [
        {'type': 'tool_result', 'tool_use_id': 't1', 'content': 'ok'}]}}


def assistant(text):
    return {'type': 'assistant', 'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': text}]}}


def write(lines):
    d = tempfile.mkdtemp()
    path = os.path.join(d, 't.jsonl')
    with open(path, 'w') as f:
        f.write(''.join(json.dumps(l) + '\n' for l in lines))
    return path


class StopGateReadsThisTurn(unittest.TestCase):
    def test_previous_turns_report_is_not_carried_into_a_short_follow_up(self):
        path = write([user('Fix the refunds total'), assistant('Working.'), tool_result(), assistant(REPORT),
                      user('Add a refunds note to the README, no report'), assistant('Added the note.')])
        text = m.last_assistant_text(path)
        self.assertIn('Added the note.', text)
        self.assertNotIn('NEONCORE-DONE', text)

    def test_tool_results_do_not_end_the_turn(self):
        path = write([user('Fix it'), assistant('Reading the file.'), tool_result(),
                      assistant(REPORT), tool_result(), assistant('All set.')])
        text = m.last_assistant_text(path)
        self.assertIn('NEONCORE-DONE', text)
        self.assertIn('Reading the file.', text)

    def test_the_message_limit_still_applies_within_a_turn(self):
        path = write([user('go')] + [assistant(f'step {i}') for i in range(10)])
        text = m.last_assistant_text(path, limit=3)
        self.assertEqual(text, 'step 7\nstep 8\nstep 9')

    def test_stop_payload_message_is_used_when_the_transcript_lags(self):
        path = write([user('Fix it'), assistant('Working.')])
        sent = {}
        m.post_json_read = lambda url, body, timeout=4: sent.setdefault('body', json.loads(body)) and None
        m.REREAD_DELAY_S = 0
        m.check_completion('s1', path, False, last_message=REPORT)
        self.assertIn('NEONCORE-DONE', sent['body']['finalText'])

    def test_stop_payload_message_already_in_the_transcript_is_not_doubled(self):
        path = write([user('Fix it'), assistant(REPORT)])
        sent = {}
        m.post_json_read = lambda url, body, timeout=4: sent.setdefault('body', json.loads(body)) and None
        m.check_completion('s1', path, False, last_message=REPORT)
        self.assertEqual(sent['body']['finalText'].count('NEONCORE-DONE'), 1)


unittest.main()

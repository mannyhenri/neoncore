"""The permission hook's wait: every poll outcome, against a fake clock.

Bug: answers given from the dashboard after ~10 minutes were silently lost. The hook waited
120s x 5 polls but Claude Code kills a hook at its default 600s, so the terminal menu took over
while the dashboard kept offering the question; a late answer resolved nothing. The hook now
waits on a deadline that stays under the timeout install.py registers, stops at once when the
server has closed the question, and tells the server when it gives up.
"""
import importlib.util, sys, unittest
sys.path.insert(0, 'agent/hooks')
spec = importlib.util.spec_from_file_location('proxy', 'agent/hooks/permission-proxy.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
ispec = importlib.util.spec_from_file_location('install', 'agent/install.py')
inst = importlib.util.module_from_spec(ispec); ispec.loader.exec_module(inst)


class Clock:
    def __init__(self): self.t = 0.0
    def now(self): return self.t
    def sleep(self, s): self.t += s


def run(outcomes, wait=600):
    """Drive wait_for_decision with scripted poll results; each poll costs its window."""
    clock, polls, posts = Clock(), [], []
    script = list(outcomes)

    def get_json(url, timeout=60):
        polls.append(url)
        r = script.pop(0) if script else {'decision': 'timeout'}
        window = int(url.rsplit('timeout=', 1)[1]) / 1000
        clock.t += window if r == {'decision': 'timeout'} else 0.01
        return r

    got = m.wait_for_decision('perm-1', wait_seconds=wait, get=get_json,
                              post=lambda url, body: posts.append(url) or {},
                              clock=clock.now, sleep=clock.sleep)
    return got, polls, posts, clock.t


class Wait(unittest.TestCase):
    def test_every_poll_outcome(self):
        cases = {
            'allowed':  ([{'decision': 'allowed', 'response': '{}'}], 'allowed', False),
            'denied':   ([{'decision': 'denied', 'response': ''}], 'denied', False),
            # server closed it (expired by TTL / answered in terminal): stop, do not spin
            'expired':  ([{'decision': 'expired'}], None, False),
            # answer arrives after several empty windows: still delivered
            'late':     ([{'decision': 'timeout'}] * 3 + [{'decision': 'allowed', 'response': '{}'}], 'allowed', False),
            # nobody answers: wait to the deadline, then tell the server
            'silence':  ([], None, True),
            # server unreachable: give up after a bounded run of errors, not a hot loop
            'errors':   ([None] * 1000, None, True),
        }
        for label, (outcomes, want, abandoned) in cases.items():
            with self.subTest(label):
                got, polls, posts, elapsed = run(outcomes)
                self.assertEqual(got.get('decision') if got else None, want)
                self.assertEqual(any(p.endswith('/api/permissions/perm-1/abandon') for p in posts), abandoned)
                self.assertLess(len(polls), 100, f'{label}: {len(polls)} polls — a hot loop')
                self.assertLessEqual(elapsed, 600 + 1, f'{label}: waited past the deadline')

    def test_expired_stops_immediately(self):
        _, polls, _, _ = run([{'decision': 'expired'}] * 50)
        self.assertEqual(len(polls), 1)

    def test_wait_stays_under_the_registered_hook_timeout(self):
        # Claude Code kills the hook at the timeout install.py registers. The wait must end
        # first, with margin for the last poll window, or the abandon call never happens.
        self.assertLessEqual(m.WAIT_SECONDS + m.POLL_TIMEOUT + 30, inst.PERMISSION_HOOK_TIMEOUT_SECONDS)

    def test_installer_registers_the_timeout_on_the_permission_hook_only(self):
        entry = inst.make_hook_entry('cmd', timeout=inst.PERMISSION_HOOK_TIMEOUT_SECONDS)
        self.assertEqual(entry['hooks'][0]['timeout'], inst.PERMISSION_HOOK_TIMEOUT_SECONDS)
        self.assertNotIn('timeout', inst.make_hook_entry('cmd')['hooks'][0])


unittest.main()

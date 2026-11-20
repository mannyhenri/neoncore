/**
 * Resolve PR Conflicts — run on its own, on a feature branch whose PR conflicts with its base.
 *
 * Features run side by side on their own branches (lib/feature-workspace.ts), so the second to merge
 * can conflict with the first. Seeded on every boot by ./index.ts.
 */
import { randomUUID } from 'crypto';
import type { SeedKit } from './kit.js';

export const PR_CONFLICTS_TEMPLATE = 'Resolve PR Conflicts';

export function seedPrConflicts({ now, stableId, insertWorkflow, step, cc, gate }: SeedKit): void {
  const wfId = stableId(PR_CONFLICTS_TEMPLATE);
  const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID();
  insertWorkflow.run(wfId, PR_CONFLICTS_TEMPLATE,
    'Run on a feature branch whose PR conflicts with its base: bring the base in → resolve keeping both sides → re-test → push and comment on the PR. Never force-pushes, never merges.', now);

  step(wfId, s1, 'Bring the base in',
    'Merge the PR\'s base branch into the feature branch and list every conflict.',
    300, 80, 'claude-code',
    {
      ...cc('backend'),
      prompt: 'Bring the base branch into this feature branch so its PR can merge cleanly. Put the branch or PR in the run\'s context; if none is given, use the branch this repo (or worktree) is on.\n\n1. Find the PR and its base: `gh pr view <branch or PR> --json number,url,baseRefName,headRefName,title,body`.\n2. Check out the head branch if you are not on it (in a feature worktree you already are). Make sure the working tree is clean; if it is not, STOP and report what is uncommitted.\n3. `git fetch origin`, then `git merge origin/<baseRefName>` (a merge, not a rebase: the branch is already pushed and may be reviewed).\n4. List every conflicted file (`git diff --name-only --diff-filter=U`).\n\nOutput:\n```\nPR: <url>  base: <base>  head: <head>\nConflicts: <N>\n- <file>\n```\nIf there are no conflicts, say `NO CONFLICTS` — the next step then only re-checks the build.',
    }, []);

  step(wfId, s2, 'Resolve the conflicts',
    'Resolve every conflict keeping the intent of BOTH sides, and explain each resolution.',
    300, 255, 'claude-code',
    {
      ...cc('backend'),
      prompt: 'Resolve every conflict from the previous step.\n\nThe base branch holds work that already merged (often another feature built side by side with this one). Keep the intent of BOTH sides: never resolve by simply taking "ours" or "theirs" for a whole file, and never drop the other side\'s work. Read the other change before deciding — `git log origin/<base> -- <file>` and the PR it came from — and read this PR\'s description so you know what this side must keep doing.\n\nFor each file: resolve, remove every conflict marker, and make sure it still builds. Where the two sides genuinely contradict, choose the behavior the merged base already ships, adapt this feature to it, and say so.\n\nThen `git add` the files and commit the merge (`git commit --no-edit`, or a message naming the base).\n\nOutput, per file:\n```\n### <file>\nOurs: <what this feature needed>\nTheirs: <what the base changed>\nResolution: <what you kept and why>\n```',
    }, [s1]);

  step(wfId, s3, 'Re-test',
    'Run the full test suite on the merged result; failures go back to the resolution.',
    300, 430, 'quality-gate',
    { ...gate('test'), routingRules: [{ id: randomUUID(), condition: 'contains', value: 'STATUS: FAIL', nextStepId: s2 }], maxCycles: 3 }, [s2]);

  step(wfId, s4, 'Push and report',
    'Push the branch (never force) and comment on the PR with what was resolved.',
    300, 605, 'claude-code',
    {
      ...cc('backend'),
      prompt: 'The merge is resolved and the tests pass. Finish:\n\n1. `git push` the branch. Do NOT force-push: if the push is rejected because someone pushed in the meantime, `git pull --no-rebase`, re-run the tests, and push again.\n2. Comment on the PR with the resolutions from the previous step: `gh pr comment <PR> --body "<summary>"`.\n3. Confirm GitHub now reports the PR as mergeable: `gh pr view <PR> --json mergeable,mergeStateStatus`.\n\nDo NOT merge the PR — a person merges it.\n\nOutput:\n```\nPR: <url>\nPushed: <commit sha>\nMergeable: <yes | no — why>\nConflicts resolved: <N>\n```',
    }, [s3]);
}

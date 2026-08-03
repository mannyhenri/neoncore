---
name: "source-command-check-merge"
description: "Check diff and potential conflicts between current branch and base branch"
---

# source-command-check-merge

Use this skill when the user asks to run the migrated source command `check-merge`.

## Command Template

# Check Merge Conflicts

Follow these steps:

1. **Detect Remote and Base Branch**
```bash
   REMOTE=$(git remote | head -1)
   BASE=$(git symbolic-ref refs/remotes/${REMOTE}/HEAD 2>/dev/null | sed "s|refs/remotes/${REMOTE}/||")
   if [ -z "$BASE" ]; then
     git rev-parse --verify ${REMOTE}/dev &>/dev/null && BASE=dev || BASE=main
   fi
   echo "Remote: $REMOTE, Base: $BASE"
```

2. **Identify Branches**
```bash
   git branch --show-current
   git fetch ${REMOTE} ${BASE}
```
   Show me the current branch name.

3. **Check Divergence**
```bash
   git log --oneline ${BASE}..HEAD
   git log --oneline HEAD..${REMOTE}/${BASE}
```
   Show commits that are:
   - On current branch but not in base (your changes)
   - On base but not in current branch (incoming changes)

4. **Show File Diff**
```bash
   git diff ${REMOTE}/${BASE}...HEAD --stat
```
   Show which files differ between branches.

5. **Check for Potential Conflicts**
```bash
   git diff ${REMOTE}/${BASE}...HEAD --name-only
```
   List files that have been modified in both branches:
```bash
   git diff ${REMOTE}/${BASE} --name-only
```

6. **Dry Run Merge**
```bash
   git merge ${REMOTE}/${BASE} --no-commit --no-ff
```
   Attempt merge without committing to detect conflicts.

7. **Abort Test Merge**
```bash
   git merge --abort
```
   Clean up after the test merge.

8. **Report Results**
   Summarize:
   - Remote and base branch used
   - Number of commits ahead/behind base
   - Files that will change
   - Any conflicts detected
   - Recommendation (safe to merge or needs attention)

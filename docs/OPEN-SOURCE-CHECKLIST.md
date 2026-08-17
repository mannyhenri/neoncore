# Open-source readiness checklist

Everything that has to be true before this repo becomes public, in the order it has to happen.
Audited 2026-08-17 against commit `fbdc0f5`.

---

## ✅ Already clear

**Secrets — audited, clean.** The whole history was scanned, not just the working tree:

```bash
# no sensitive paths ever committed (only .env.example and a benign .xcode.env)
git log --all --pretty=format: --name-only --diff-filter=A | sort -u \
  | grep -iE '\.env$|\.p8$|\.pem$|\.key$|\.mobileprovision|id_rsa|\.db$'

# no credential material in tracked content
git grep -nIE '(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY)'
```

Both come back empty. `neoncore.db` is untracked. The fleet token is redacted at the settings
route by design, and APNs keys are environment paths that are never read into the database.

**This is the expensive problem you don't have** — no history rewriting is needed for secrets.

---

## 🚫 Blockers

### 1. Internal material is tracked — and deleting it is not enough

89 tracked files are working material, not product:

| Path | What it is |
|---|---|
| `.neoncore/sessions/journal.md` | 1,844 lines of session forensics |
| `.neoncore/unsupervised-log.md` | 476 lines of decisions made autonomously while you were out |
| `docs/gridlight-strategy.md` | 364 lines of business strategy |
| `todos/`, `docs/plans/`, `docs/brainstorms/`, `docs/research/` | in-flight planning |
| `eval/` (42 files), `.agents/` (28 files) | internal harness and agent skills |

**The trap:** `git rm` only removes them from the *tip*. `.neoncore/sessions/journal.md` appears in
**549 commits** and stays fully recoverable by anyone who clones. Pick one:

- **Publish a fresh repo** (recommended) — build the cleaned tree, `git init`, one initial commit,
  push to the new public remote. Keep this repo private with its full history. Simplest, and
  there's no way to get it wrong.
- **Rewrite history** with `git-filter-repo --invert-paths --path .neoncore --path todos ...`.
  Preserves contribution history; changes every SHA and breaks existing clones.

```bash
# verify afterwards — must print nothing
git log --all --pretty=format: --name-only | sort -u | grep -E '^(\.neoncore|todos|eval|\.agents)/'
```

### 2. `mobile/README.md` documents a workflow that no longer exists

It still instructs `npx expo install`, `npx expo start`, Expo Go and EAS/OTA updates. The app was
**ejected from Expo**; `mobile/RELEASE.md` says so explicitly and says never to run `expo prebuild`.
Two docs in the same folder contradict each other, and a contributor following the README will hit
a wall immediately. **Rewrite it against RELEASE.md.**

### 3. `DEVELOPMENT_TEAM = 3AXRJ22S9P` is hardcoded

In `mobile/ios/NeonCore.xcodeproj/project.pbxproj` (2 configurations). Not a secret — Team IDs are
public — but every contributor's build fails until they change it. Move it to a local xcconfig, or
document it prominently as a required one-line edit.

---

## ⚠️ Should fix before launch

- **Bundle identifier** `ai.gridlight.neoncore` is yours. Contributors need their own to build to
  a device; document it next to the team ID.
- **README/docs currency** — the root README has been rewritten; `FEATURES.md`, `INSTALL.md`,
  `SETUP.md` and `TESTING.md` still reference the old structure in places. Read them once each.
- **Issue and PR templates** — `.github/ISSUE_TEMPLATE/`. The "cartridge doesn't appear" bug will
  be your most common report; prompt for the baked-in URL and `/api/health` output up front.
- **CI** — nothing runs on PRs today. A minimal GitHub Action (`npm test` in each workspace plus
  `tsc --noEmit`) means a stranger's PR proves itself.
- **`gridlight.json`** packages NeonCore as a Gridlight desktop app. Harmless, but explain it or
  drop it from the public tree — it reads as a stray file otherwise.
- **A `CHANGELOG.md`** — you're at 0.7.0 with no public record of what changed.

---

## 📋 Nice to have

- **Code of Conduct** — GitHub will prompt for one; Contributor Covenant is one command.
- **A demo GIF** of an approval being answered from the phone. That is the moment the product
  explains itself, and a still image can't show it.
- **Screenshot regeneration script.** The images in `docs/images/` came from a seeded demo fleet on
  an isolated server. Committing that seed script means the next person can regenerate them instead
  of publishing their own repo names.
- **`good first issue` labels** on three or four real, small tasks before you announce.

---

## Launch sequence

1. Decide **fresh repo** vs **history rewrite** (blocker 1) — everything else depends on it
2. Fix `mobile/README.md` (blocker 2) and the team ID (blocker 3)
3. Add CI so incoming PRs are verifiable
4. Build the cleaned tree, verify with the two grep commands above
5. Push to the public remote, enable Discussions and Security Advisories
6. Announce

## Verifying the cleaned tree

```bash
# 1. no internal material anywhere in history
git log --all --pretty=format: --name-only | sort -u \
  | grep -E '^(\.neoncore|todos|eval|\.agents|docs/(plans|brainstorms|research))/' && echo "STILL PRESENT"

# 2. no credentials
git grep -nIE '(sk-[A-Za-z0-9_-]{20,}|ghp_|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY)'

# 3. license declared everywhere
rg '"license"' package.json */package.json packages/*/package.json

# 4. a clean clone actually builds
git clone <public-url> /tmp/verify && cd /tmp/verify && npm install && npm run build && npm start
```

Step 4 is the one people skip. Do it in an empty directory — it is the only way to catch a build
that depends on something untracked on your machine.

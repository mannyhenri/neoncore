/**
 * THE FIX GUARDRAILS — checked by the server on the fix's diff, never just asked for in a prompt
 * (docs/plans/bug-triage.md, "Guardrails" 3–5). A fix that fails one is refused and the issue is
 * handed to a person with the reason.
 */

export interface FileDiff {
  path: string;
  /** The path before the change ('' for a new file). */
  oldPath: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
  added: string[];
  removed: string[];
}

/** A unified diff (git diff) → one entry per file. */
export function parseDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  for (const line of diff.split('\n')) {
    const head = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (head) {
      cur = { path: head[2], oldPath: head[1], status: 'modified', added: [], removed: [] };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('new file mode')) { cur.status = 'added'; cur.oldPath = ''; continue; }
    if (line.startsWith('deleted file mode')) { cur.status = 'deleted'; continue; }
    if (line.startsWith('rename from ')) { cur.status = 'renamed'; cur.oldPath = line.slice('rename from '.length); continue; }
    if (line.startsWith('rename to ')) { cur.path = line.slice('rename to '.length); continue; }
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@') || line.startsWith('index ')) continue;
    if (line.startsWith('+')) cur.added.push(line.slice(1));
    else if (line.startsWith('-')) cur.removed.push(line.slice(1));
  }
  return files;
}

/** A glob (`**`, `*`, `?`) → RegExp, matched against a repo-relative path. A pattern with no `/` matches the basename anywhere. */
export function globToRegExp(glob: string): RegExp {
  const g = glob.trim().replace(/^\.\//, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { re += g[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += g[i + 2] === '/' ? 2 : 1; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(g.includes('/') ? `^${re}$` : `(^|/)${re}$`);
}

export function matchesAny(path: string, globs: readonly string[]): string | null {
  for (const g of globs) if (g.trim() && globToRegExp(g).test(path)) return g;
  return null;
}

export interface GuardVerdict { ok: boolean; problems: string[] }

/** Guardrail 3: nothing a fix touches may be on a protected path. */
export function checkProtectedPaths(files: FileDiff[], protectedPaths: readonly string[]): GuardVerdict {
  const problems: string[] = [];
  for (const f of files) {
    for (const p of [f.path, f.oldPath].filter(Boolean)) {
      const hit = matchesAny(p, protectedPaths);
      if (hit) { problems.push(`${p} is a protected path (${hit}) — automatic fixes may not touch it`); break; }
    }
  }
  return { ok: problems.length === 0, problems };
}

/** Guardrail 4: the fix stays small. The reproduction test itself does not count toward the size. */
export function checkSize(files: FileDiff[], limits: { maxFiles: number; maxLines: number }, exclude: readonly string[] = []): GuardVerdict {
  const counted = files.filter((f) => !exclude.includes(f.path));
  const lines = counted.reduce((n, f) => n + f.added.length + f.removed.length, 0);
  const problems: string[] = [];
  if (counted.length > limits.maxFiles) problems.push(`the fix changes ${counted.length} files (limit ${limits.maxFiles})`);
  if (lines > limits.maxLines) problems.push(`the fix changes ${lines} lines (limit ${limits.maxLines})`);
  return { ok: problems.length === 0, problems };
}

/** Is this path a test file? */
export function isTestFile(path: string): boolean {
  return /(^|\/)(__tests__|tests?|spec|specs)\//.test(path)
    || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path)
    || /(^|\/)test_[^/]+\.py$/.test(path) || /_test\.(py|go|rb)$/.test(path) || /_spec\.rb$/.test(path)
    || /Tests?\.(java|kt|cs)$/.test(path);
}

/** Lines that declare a test case. */
const TEST_CASE = /\b(it|test|specify)\s*(\.each\s*\(.*?\))?\s*\(|\bdef\s+test_\w*|\bfunc\s+Test\w*\s*\(|@Test\b/;
/** Lines that turn a test off or narrow a run to a few. Each is refused when a fix ADDS it. */
export const SKIP_PATTERNS: readonly [string, RegExp][] = [
  ['.skip', /\.(skip)\s*\(/],
  ['.only', /\.(only)\s*\(/],
  ['xit', /\bx(it|test|describe)\s*\(/],
  ['@skip', /@(unittest\.)?skip(If|Unless)?\b/],
  ['pytest.mark.skip', /pytest\.mark\.(skip|skipif|xfail)\b/],
  ['t.Skip', /\bt\.Skip(Now|f)?\(/],
  ['@Disabled / @Ignore', /@(Disabled|Ignore)\b/],
  ['test.todo', /\b(it|test)\.todo\s*\(/],
];
/** Lines that assert. Removing or changing one in an EXISTING test is weakening it. */
const ASSERTION = /\b(expect|assert\w*|should|must)\b|\.to(Be|Equal|Match|Throw|Have)\w*\(|\bt\.(Error|Fatal|Fail)\w*\(/;

/**
 * Guardrail 5 — TEST INTEGRITY. A fix may add tests; it may not delete a test file, remove a test
 * case, switch a test off (skip / only / xit / @skip / pytest.mark.skip …), or change or drop an
 * assertion in a test that already existed. (A new test file is free, except for skips.)
 */
export function checkTestIntegrity(files: FileDiff[]): GuardVerdict {
  const problems: string[] = [];
  for (const f of files) {
    const testy = isTestFile(f.path) || (f.oldPath !== '' && isTestFile(f.oldPath));
    if (!testy) continue;
    if (f.status === 'deleted') { problems.push(`${f.oldPath || f.path}: a test file was deleted`); continue; }
    for (const line of f.added) {
      for (const [label, re] of SKIP_PATTERNS) {
        if (re.test(line)) { problems.push(`${f.path}: adds ${label} — a fix may not switch tests off`); break; }
      }
    }
    if (f.status === 'added') continue;
    const addedSet = new Map<string, number>();
    for (const l of f.added) addedSet.set(l.trim(), (addedSet.get(l.trim()) ?? 0) + 1);
    const removedCases = f.removed.filter((l) => TEST_CASE.test(l)).length;
    const addedCases = f.added.filter((l) => TEST_CASE.test(l)).length;
    if (removedCases > addedCases) problems.push(`${f.path}: removes ${removedCases - addedCases} existing test case(s)`);
    for (const l of f.removed) {
      if (!ASSERTION.test(l)) continue;
      const k = l.trim();
      const n = addedSet.get(k) ?? 0;
      if (n > 0) { addedSet.set(k, n - 1); continue; }   // moved, not changed
      problems.push(`${f.path}: changes or removes an existing assertion — "${k.slice(0, 120)}"`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/** All three, as one verdict. */
export function checkFix(diff: string, opts: { protectedPaths: readonly string[]; maxFiles: number; maxLines: number; reproTestFile?: string }): GuardVerdict & { files: FileDiff[] } {
  const files = parseDiff(diff);
  const problems = [
    ...checkProtectedPaths(files, opts.protectedPaths).problems,
    ...checkSize(files, opts, opts.reproTestFile ? [opts.reproTestFile] : []).problems,
    ...checkTestIntegrity(files).problems,
  ];
  return { ok: problems.length === 0, problems, files };
}

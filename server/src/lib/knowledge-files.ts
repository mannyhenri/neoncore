/**
 * The hand-written knowledge files a project keeps. ONE registry — the panel, the mobile
 * screen, the Send Context modal and the journal route all read it.
 *
 * It used to be four: `progress.md`, `decisions.md`, `gotchas.md`, `details.md`. The first
 * three were appended automatically by the session summarizer and read by nobody. The live
 * `progress.md` for gridlight-manager was a list of prompt fragments with "— {}" stapled to
 * the end of each, and several entries reading "(No user prompt captured)". Their content
 * already exists in a better place: a session's summary lives on the session row, which is
 * what the Sessions tab shows.
 *
 * `details.md` survives because it is the opposite of those three — a person writes it, and it
 * is the thing Send Context injects into a cartridge.
 *
 * What replaced them is `workflow_reports`: the JSON a completion report produces at the end
 * of every run, stored per repo and readable back. That is a record of what actually happened,
 * written once per run rather than appended to on every hook.
 */
export const KNOWLEDGE_FILES = ['details.md'] as const;
export type KnowledgeFile = (typeof KNOWLEDGE_FILES)[number];

/** Retired — refused at the write path so nothing quietly recreates them. */
export const RETIRED_KNOWLEDGE_FILES = ['progress.md', 'decisions.md', 'gotchas.md'] as const;

export function isKnowledgeFile(name: string): name is KnowledgeFile {
  return (KNOWLEDGE_FILES as readonly string[]).includes(name);
}

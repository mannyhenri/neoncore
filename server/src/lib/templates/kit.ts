import type { Database as DatabaseType } from 'better-sqlite3';

/** What every template family's seeder is handed by ./index.ts. */
export interface SeedKit {
  db: DatabaseType;
  /** One timestamp for the whole seed. */
  now: string;
  /** The template's established id, or a new one the first time it is ever seeded. */
  stableId(name: string): string;
  insertWorkflow: { run(id: string, name: string, description: string, now: string): unknown };
  step(
    wfId: string, id: string, name: string, desc: string, x: number, y: number, type: string,
    config: Record<string, unknown>, deps: string[], auto?: boolean,
  ): void;
  /** Config for an agent step with a role (claude-code). */
  cc(role: string, extra?: Record<string, unknown>): Record<string, unknown>;
  /** Config for a quality gate of the given type. */
  gate(gateType: string): Record<string, unknown>;
}

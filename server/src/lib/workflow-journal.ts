import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import db from '../db.js';

export interface WorkflowJournalEntry {
  id: string;
  workflowId: string;
  stepId: string;
  stepName: string;
  eventType: string;
  message: string;
  data: Record<string, unknown>;
  createdAt: string;
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

export function recordWorkflowJournal(
  database: Database,
  entry: {
    workflowId: string;
    stepId?: string;
    stepName?: string;
    eventType?: string;
    message: string;
    data?: Record<string, unknown>;
    createdAt?: string;
  },
): void {
  database.prepare(`
    INSERT INTO workflow_journal
      (id, workflow_id, step_id, step_name, event_type, message, data, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    entry.workflowId,
    entry.stepId ?? '',
    entry.stepName ?? '',
    entry.eventType ?? 'info',
    entry.message,
    json(entry.data),
    entry.createdAt ?? new Date().toISOString(),
  );
}

export function recordJournal(entry: Parameters<typeof recordWorkflowJournal>[1]): void {
  recordWorkflowJournal(db, entry);
}

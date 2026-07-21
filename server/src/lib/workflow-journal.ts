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

export function listWorkflowJournal(workflowId: string, limit = 200): WorkflowJournalEntry[] {
  const rows = db.prepare(`
    SELECT * FROM workflow_journal
    WHERE workflow_id = ?
    ORDER BY created_at ASC
    LIMIT ?
  `).all(workflowId, Math.max(1, Math.min(limit, 1000))) as Record<string, unknown>[];

  return rows.map((row) => {
    let data: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse((row.data as string) || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
    } catch {
      data = {};
    }
    return {
      id: row.id as string,
      workflowId: row.workflow_id as string,
      stepId: (row.step_id as string) || '',
      stepName: (row.step_name as string) || '',
      eventType: (row.event_type as string) || 'info',
      message: (row.message as string) || '',
      data,
      createdAt: row.created_at as string,
    };
  });
}

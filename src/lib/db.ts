import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env.js';
import { logger } from './logger.js';

export interface TaskRow {
  short_id: string;
  google_task_id: string;
  list_id: string;
  title: string;
  deadline: string | null;
  created_at: string;
  completed_at: string | null;
  deleted_at: string | null;
  priority: string | null;
}

export interface ReminderRow {
  id: number;
  short_id: string;
  remind_at: string;
  kind: 'deadline' | 'digest';
  sent_at: string | null;
}

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  const dbPath = env.DB_PATH;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      short_id       TEXT PRIMARY KEY,
      google_task_id TEXT NOT NULL,
      list_id        TEXT NOT NULL,
      title          TEXT NOT NULL,
      deadline       TEXT,
      created_at     TEXT NOT NULL,
      completed_at   TEXT,
      deleted_at     TEXT
    );
    CREATE TABLE IF NOT EXISTS reminders (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      short_id   TEXT NOT NULL,
      remind_at  TEXT NOT NULL,
      kind       TEXT NOT NULL,
      sent_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_rem_due ON reminders(remind_at, sent_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_open ON tasks(completed_at, deleted_at);

    CREATE TABLE IF NOT EXISTS clarifications (
      ref          TEXT PRIMARY KEY,
      original     TEXT NOT NULL,
      question     TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      resolved_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS recurring (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      title          TEXT NOT NULL,
      recurrence     TEXT NOT NULL,
      time_of_day    TEXT,
      list_name      TEXT,
      priority       TEXT NOT NULL DEFAULT 'medium',
      created_at     TEXT NOT NULL,
      last_fired_ymd TEXT,
      cancelled_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_rec_active ON recurring(cancelled_at);
  `);

  // Idempotent migration: add `priority` column if this DB predates it.
  const cols = db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'priority')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN priority TEXT DEFAULT 'medium'`);
    logger.info('sqlite: migrated tasks.priority column');
  }

  logger.info({ dbPath }, 'sqlite: opened');
  _db = db;
  return db;
}

/** First 8 chars of the Google task id. Unique enough for personal scale. */
export function shortIdOf(googleId: string): string {
  return googleId.slice(0, 8);
}

export function insertTask(row: Omit<TaskRow, 'completed_at' | 'deleted_at'>): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO tasks
       (short_id, google_task_id, list_id, title, deadline, created_at, completed_at, deleted_at, priority)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    )
    .run(
      row.short_id,
      row.google_task_id,
      row.list_id,
      row.title,
      row.deadline,
      row.created_at,
      row.priority ?? 'medium',
    );
}

export function getTaskByShortId(shortId: string): TaskRow | null {
  const row = getDb()
    .prepare(`SELECT * FROM tasks WHERE short_id = ? AND deleted_at IS NULL`)
    .get(shortId) as TaskRow | undefined;
  return row ?? null;
}

export function markTaskCompleted(shortId: string, at: string): void {
  getDb().prepare(`UPDATE tasks SET completed_at = ? WHERE short_id = ?`).run(at, shortId);
}

export function markTaskDeleted(shortId: string, at: string): void {
  getDb().prepare(`UPDATE tasks SET deleted_at = ? WHERE short_id = ?`).run(at, shortId);
}

export function updateTaskDeadline(shortId: string, deadline: string | null): void {
  getDb().prepare(`UPDATE tasks SET deadline = ? WHERE short_id = ?`).run(deadline, shortId);
}

export function listOpenTasks(limit: number): TaskRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM tasks
       WHERE completed_at IS NULL AND deleted_at IS NULL
       ORDER BY COALESCE(deadline, '9999') ASC, created_at DESC
       LIMIT ?`,
    )
    .all(limit) as TaskRow[];
}

export interface StatsSnapshot {
  openCount: number;
  closedThisWeek: number;
  overdueCount: number;
  oldestOpen: TaskRow[];
}

export function getStats(now: Date, weekLookbackDays = 7): StatsSnapshot {
  const db = getDb();
  const nowIso = now.toISOString();
  const weekAgoIso = new Date(now.getTime() - weekLookbackDays * 86_400_000).toISOString();

  const openRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tasks WHERE completed_at IS NULL AND deleted_at IS NULL`,
    )
    .get() as { n: number };
  const closedRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tasks WHERE completed_at IS NOT NULL AND completed_at >= ?`,
    )
    .get(weekAgoIso) as { n: number };
  const overdueRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tasks
       WHERE completed_at IS NULL AND deleted_at IS NULL
         AND deadline IS NOT NULL AND deadline < ?`,
    )
    .get(nowIso) as { n: number };
  const oldestOpen = db
    .prepare(
      `SELECT * FROM tasks
       WHERE completed_at IS NULL AND deleted_at IS NULL
       ORDER BY created_at ASC
       LIMIT 3`,
    )
    .all() as TaskRow[];

  return {
    openCount: openRow.n,
    closedThisWeek: closedRow.n,
    overdueCount: overdueRow.n,
    oldestOpen,
  };
}

export function searchOpenTasks(query: string, limit: number): TaskRow[] {
  // Escape SQL LIKE wildcards so user input is treated as a literal substring.
  const escaped = query.replace(/\\/g, '\\\\').replace(/[%_]/g, '\\$&');
  const like = `%${escaped}%`;
  return getDb()
    .prepare(
      `SELECT * FROM tasks
       WHERE completed_at IS NULL AND deleted_at IS NULL
         AND LOWER(title) LIKE LOWER(?) ESCAPE '\\'
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(like, limit) as TaskRow[];
}

export function insertReminder(row: {
  short_id: string;
  remind_at: string;
  kind: ReminderRow['kind'];
}): void {
  getDb()
    .prepare(`INSERT INTO reminders (short_id, remind_at, kind, sent_at) VALUES (?, ?, ?, NULL)`)
    .run(row.short_id, row.remind_at, row.kind);
}

export function dueReminders(nowIso: string): ReminderRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM reminders WHERE sent_at IS NULL AND remind_at <= ? ORDER BY remind_at ASC`,
    )
    .all(nowIso) as ReminderRow[];
}

export function markReminderSent(id: number, at: string): void {
  getDb().prepare(`UPDATE reminders SET sent_at = ? WHERE id = ?`).run(at, id);
}

export function deleteRemindersForTask(shortId: string): void {
  getDb().prepare(`DELETE FROM reminders WHERE short_id = ?`).run(shortId);
}

export function hasDigestToday(dateYmd: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 FROM reminders WHERE kind = 'digest' AND substr(sent_at, 1, 10) = ? LIMIT 1`,
    )
    .get(dateYmd);
  return row !== undefined;
}

export function recordDigestSent(dateYmd: string, at: string): void {
  getDb()
    .prepare(
      `INSERT INTO reminders (short_id, remind_at, kind, sent_at) VALUES (?, ?, 'digest', ?)`,
    )
    .run(`digest-${dateYmd}`, at, at);
}

// ---- clarifications ------------------------------------------------------

export interface ClarificationRow {
  ref: string;
  original: string;
  question: string;
  created_at: string;
  resolved_at: string | null;
}

export function insertClarification(
  ref: string,
  original: string,
  question: string,
  createdAt: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO clarifications (ref, original, question, created_at, resolved_at)
       VALUES (?, ?, ?, ?, NULL)`,
    )
    .run(ref, original, question, createdAt);
}

export function getClarification(ref: string): ClarificationRow | null {
  const row = getDb()
    .prepare(`SELECT * FROM clarifications WHERE ref = ? AND resolved_at IS NULL`)
    .get(ref) as ClarificationRow | undefined;
  return row ?? null;
}

export function markClarificationResolved(ref: string, at: string): void {
  getDb().prepare(`UPDATE clarifications SET resolved_at = ? WHERE ref = ?`).run(at, ref);
}

// ---- recurring templates -------------------------------------------------

export interface RecurringRow {
  id: number;
  title: string;
  recurrence: string;
  time_of_day: string | null;
  list_name: string | null;
  priority: string;
  created_at: string;
  last_fired_ymd: string | null;
  cancelled_at: string | null;
}

export function insertRecurring(row: {
  title: string;
  recurrence: string;
  time_of_day: string | null;
  list_name: string | null;
  priority: string;
  created_at: string;
}): number {
  const res = getDb()
    .prepare(
      `INSERT INTO recurring
       (title, recurrence, time_of_day, list_name, priority, created_at, last_fired_ymd, cancelled_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
    )
    .run(row.title, row.recurrence, row.time_of_day, row.list_name, row.priority, row.created_at);
  return Number(res.lastInsertRowid);
}

export function activeRecurring(): RecurringRow[] {
  return getDb()
    .prepare(`SELECT * FROM recurring WHERE cancelled_at IS NULL ORDER BY id ASC`)
    .all() as RecurringRow[];
}

export function markRecurringFired(id: number, ymd: string): void {
  getDb().prepare(`UPDATE recurring SET last_fired_ymd = ? WHERE id = ?`).run(ymd, id);
}

export function cancelRecurring(id: number, at: string): void {
  getDb().prepare(`UPDATE recurring SET cancelled_at = ? WHERE id = ?`).run(at, id);
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env.js';
import { getDb } from './db.js';
import { logger } from './logger.js';

const RETENTION_DAYS = 14;

function ymdUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseYmd(name: string): Date | null {
  const m = name.match(/backup-(\d{4})-(\d{2})-(\d{2})\.db$/);
  if (!m || !m[1] || !m[2] || !m[3]) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Copy the SQLite DB to `data/backup-YYYY-MM-DD.db` once per UTC day.
 * Uses better-sqlite3's online backup so the copy is consistent.
 * Prunes backups older than RETENTION_DAYS.
 */
export async function backupDbIfNeeded(now: Date = new Date()): Promise<void> {
  const dir = path.dirname(env.DB_PATH);
  const today = ymdUtc(now);
  const target = path.join(dir, `backup-${today}.db`);

  if (fs.existsSync(target)) {
    logger.debug({ target }, 'backup already exists for today');
    return prune(dir, now);
  }

  try {
    const db = getDb();
    // better-sqlite3 ≥ 7 exposes Database#backup(destination) returning a Promise
    await db.backup(target);
    logger.info({ target }, 'sqlite: backup written');
  } catch (err) {
    logger.error({ err, target }, 'sqlite: backup failed');
    return;
  }
  return prune(dir, now);
}

function prune(dir: string, now: Date): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    logger.debug({ err }, 'backup prune skipped (dir read failed)');
    return;
  }
  const cutoff = now.getTime() - RETENTION_DAYS * 86_400_000;
  for (const name of entries) {
    const d = parseYmd(name);
    if (!d) continue;
    if (d.getTime() >= cutoff) continue;
    const full = path.join(dir, name);
    try {
      fs.unlinkSync(full);
      logger.debug({ file: full }, 'sqlite: old backup pruned');
    } catch (err) {
      logger.warn({ err, file: full }, 'sqlite: prune failed');
    }
  }
}

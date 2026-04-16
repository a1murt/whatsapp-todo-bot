import { env } from '../config/env.js';
import {
  activeRecurring,
  dueReminders,
  getDb,
  hasDigestToday,
  listOpenTasks,
  markReminderSent,
  markRecurringFired,
  recordDigestSent,
  type RecurringRow,
  type TaskRow,
} from '../lib/db.js';
import { backupDbIfNeeded } from '../lib/backup.js';
import { logger } from '../lib/logger.js';
import { formatTaskList } from '../commands/command-router.js';
import type { Task } from '../schemas/task.schema.js';
import type { TaskSink } from './task.service.js';
import type { WhatsAppService } from './whatsapp.service.js';

const POLL_INTERVAL_MS = 60_000;

export interface Scheduler {
  start(): void;
  stop(): void;
}

function ymdInTimezone(date: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const d = parts.find((p) => p.type === 'day')?.value;
  return `${y}-${m}-${d}`;
}

function dayNameInTimezone(date: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' })
    .format(date)
    .toLowerCase();
}

function mmddInTimezone(date: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const m = parts.find((p) => p.type === 'month')?.value;
  const d = parts.find((p) => p.type === 'day')?.value;
  return `${m}-${d}`;
}

function dayNumInTimezone(date: Date, tz: string): number {
  return Number(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, day: '2-digit' }).format(date),
  );
}

function hourInTimezone(date: Date, tz: string): number {
  return Number(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour: '2-digit', hour12: false }).format(
      date,
    ),
  );
}

/** Returns true if the recurrence pattern fires on the given date in tz. */
export function matchesRecurrence(recurrence: string, date: Date, tz: string): boolean {
  if (recurrence === 'daily') return true;
  const dayName = dayNameInTimezone(date, tz);
  if (recurrence === 'weekdays') return !['sat', 'sun'].includes(dayName);
  if (recurrence.startsWith('weekly:')) return recurrence.slice(7).toLowerCase() === dayName;
  if (recurrence.startsWith('monthly:')) {
    const n = parseInt(recurrence.slice(8), 10);
    return Number.isFinite(n) && n === dayNumInTimezone(date, tz);
  }
  if (recurrence.startsWith('yearly:')) {
    return recurrence.slice(7) === mmddInTimezone(date, tz);
  }
  return false;
}

export function createScheduler(wa: WhatsAppService, sink: TaskSink): Scheduler {
  let timer: NodeJS.Timeout | null = null;

  function priorityEmoji(priority: string | null): string {
    switch (priority) {
      case 'high':
        return '🔥';
      case 'low':
        return '💤';
      default:
        return '⏰';
    }
  }

  function formatDeadlineReminder(row: TaskRow): string {
    const parts: string[] = [`${priorityEmoji(row.priority)} Напоминание`, row.title];
    if (row.deadline) {
      const d = new Date(row.deadline);
      if (!Number.isNaN(d.getTime())) {
        const fmt = new Intl.DateTimeFormat('ru-RU', {
          timeZone: env.TIMEZONE,
          day: '2-digit',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        }).format(d);
        parts.push(`(${fmt})`);
      }
    }
    parts.push(`#${row.short_id}`);
    return parts.join('  ');
  }

  function spawnReadyTime(tmpl: RecurringRow): number {
    if (!tmpl.time_of_day) return env.DIGEST_HOUR;
    const h = parseInt(tmpl.time_of_day.slice(0, 2), 10);
    return Number.isFinite(h) ? h : env.DIGEST_HOUR;
  }

  async function spawnRecurring(tmpl: RecurringRow, todayYmd: string): Promise<void> {
    const task: Task = {
      isTask: true,
      title: tmpl.title,
      description: null,
      deadline: null,
      priority: (tmpl.priority as Task['priority']) ?? 'medium',
      sourceLang: 'other',
      listName: tmpl.list_name,
      recurrence: null,
      needsClarification: false,
      clarifyQuestion: null,
    };
    try {
      const created = await sink.create(task);
      await wa.notifySelf(`🔁 ${tmpl.title}  #${created.shortId}`);
      markRecurringFired(tmpl.id, todayYmd);
      logger.info({ templateId: tmpl.id, shortId: created.shortId }, 'recurring spawned');
    } catch (err) {
      logger.error({ err, templateId: tmpl.id }, 'recurring spawn failed');
    }
  }

  async function tick() {
    const now = new Date();
    try {
      // 1) deadline reminders
      const due = dueReminders(now.toISOString());
      for (const r of due) {
        if (r.kind !== 'deadline') {
          markReminderSent(r.id, now.toISOString());
          continue;
        }
        const task = getDb()
          .prepare(`SELECT * FROM tasks WHERE short_id = ?`)
          .get(r.short_id) as TaskRow | undefined;
        if (!task || task.completed_at || task.deleted_at) {
          markReminderSent(r.id, now.toISOString());
          continue;
        }
        await wa.notifySelf(formatDeadlineReminder(task));
        markReminderSent(r.id, now.toISOString());
        logger.info({ shortId: r.short_id }, 'reminder sent');
      }

      const todayYmd = ymdInTimezone(now, env.TIMEZONE);
      const currentHour = hourInTimezone(now, env.TIMEZONE);

      // 2) morning digest + daily DB backup
      if (currentHour === env.DIGEST_HOUR && !hasDigestToday(todayYmd)) {
        const open = listOpenTasks(50);
        if (open.length > 0) {
          const items = open.map((t) => ({ title: t.title, due: t.deadline }));
          const body = `🌅 Доброе утро!\n\n${formatTaskList(items, env.TIMEZONE)}`;
          await wa.notifySelf(body);
          logger.info({ count: open.length }, 'digest sent');
        }
        recordDigestSent(todayYmd, now.toISOString());
        // Run DB backup once per day, piggy-backing on digest hour.
        await backupDbIfNeeded(now).catch((err) =>
          logger.warn({ err }, 'backupDbIfNeeded crashed'),
        );
      }

      // 3) recurring spawner
      const templates = activeRecurring();
      for (const tmpl of templates) {
        if (tmpl.last_fired_ymd === todayYmd) continue;
        if (!matchesRecurrence(tmpl.recurrence, now, env.TIMEZONE)) continue;
        if (currentHour < spawnReadyTime(tmpl)) continue;
        await spawnRecurring(tmpl, todayYmd);
      }
    } catch (err) {
      logger.error({ err }, 'scheduler tick failed');
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
      void tick();
      logger.info({ intervalMs: POLL_INTERVAL_MS }, 'scheduler started');
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

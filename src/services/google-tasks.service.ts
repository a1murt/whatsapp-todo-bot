import { OAuth2Client } from 'google-auth-library';
import { google, type tasks_v1 } from 'googleapis';
import { env } from '../config/env.js';
import { insertTask, shortIdOf } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { TaskSinkError } from '../schemas/errors.js';
import type { Task } from '../schemas/task.schema.js';
import type { CreatedTask, StoredTask, TaskSink } from './task.service.js';

function buildOAuthClient(): OAuth2Client {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) {
    throw new TaskSinkError(
      'Google Tasks credentials missing — set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN (see scripts/google-auth.mjs)',
    );
  }
  const client = new OAuth2Client(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
  client.setCredentials({ refresh_token: env.GOOGLE_REFRESH_TOKEN });
  return client;
}

function toDueDate(iso: string | null): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  // Google Tasks `due` is RFC3339 but only the date portion is honored.
  return `${d.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

// Google Tasks notes field caps at 8192 chars; leave room for the ellipsis.
const NOTES_MAX = 7900;

function clampNotes(s: string): string {
  if (s.length <= NOTES_MAX) return s;
  return s.slice(0, NOTES_MAX) + '\n…[truncated]';
}

function buildNotes(task: Task): string | undefined {
  const parts: string[] = [];
  if (task.description) parts.push(task.description);
  if (task.deadline) {
    const d = new Date(task.deadline);
    if (!Number.isNaN(d.getTime())) {
      const time = new Intl.DateTimeFormat('ru-RU', {
        timeZone: env.TIMEZONE,
        hour: '2-digit',
        minute: '2-digit',
      }).format(d);
      parts.push(`⏰ ${time} (${env.TIMEZONE})`);
    }
  }
  if (task.priority !== 'medium') parts.push(`priority: ${task.priority}`);
  if (parts.length === 0) return undefined;
  return clampNotes(parts.join('\n'));
}

function formatTitle(task: Task): string {
  const prefix = task.priority === 'high' ? '🔥 ' : '';
  return `${prefix}${task.title}`.slice(0, 1024);
}

function fromGoogle(item: tasks_v1.Schema$Task, listId: string): StoredTask {
  return {
    id: item.id ?? '',
    listId,
    title: item.title ?? '(без названия)',
    notes: item.notes ?? null,
    due: item.due ?? null,
    status: item.status === 'completed' ? 'completed' : 'needsAction',
  };
}

export function createGoogleTasksSink(): TaskSink {
  const auth = buildOAuthClient();
  const tasksApi = google.tasks({ version: 'v1', auth });
  const defaultList = env.GOOGLE_TASKLIST_ID;

  // listName -> listId cache (populated lazily; Phase 5 uses this path)
  const listCache = new Map<string, string>();

  async function resolveListId(name: string | null): Promise<string> {
    if (!name) return defaultList;
    const cached = listCache.get(name);
    if (cached) return cached;
    try {
      const { data } = await tasksApi.tasklists.list({ maxResults: 100 });
      for (const l of data.items ?? []) {
        if (l.title && l.id) listCache.set(l.title, l.id);
      }
      const hit = listCache.get(name);
      if (hit) return hit;
      const created = await tasksApi.tasklists.insert({ requestBody: { title: name } });
      const newId = created.data.id;
      if (!newId) throw new TaskSinkError('tasklists.insert returned no id');
      listCache.set(name, newId);
      logger.info({ name, listId: newId }, 'google tasks: created list');
      return newId;
    } catch (err) {
      logger.warn({ err, name }, 'resolveListId fallback to default');
      return defaultList;
    }
  }

  return {
    async create(task: Task): Promise<CreatedTask> {
      try {
        const tasklist = await resolveListId(task.listName);
        const notes = buildNotes(task) ?? null;
        const due = toDueDate(task.deadline) ?? null;
        const body: tasks_v1.Schema$Task = {
          title: formatTitle(task),
          notes,
          due,
        };
        const res = await tasksApi.tasks.insert({ tasklist, requestBody: body });
        const id = res.data.id;
        if (!id) throw new TaskSinkError('Google Tasks insert returned no id');
        const shortId = shortIdOf(id);
        insertTask({
          short_id: shortId,
          google_task_id: id,
          list_id: tasklist,
          title: task.title,
          deadline: task.deadline,
          created_at: new Date().toISOString(),
          priority: task.priority,
        });
        logger.info({ id, tasklist, googleLink: res.data.selfLink }, 'google tasks: inserted');
        return { id, listId: tasklist, shortId };
      } catch (err) {
        throw new TaskSinkError('Google Tasks insert failed', err);
      }
    },

    async listOpen(limit = 10): Promise<StoredTask[]> {
      try {
        const res = await tasksApi.tasks.list({
          tasklist: defaultList,
          showCompleted: false,
          showHidden: false,
          maxResults: Math.min(Math.max(limit, 1), 100),
        });
        const items = res.data.items ?? [];
        return items.map((it) => fromGoogle(it, defaultList));
      } catch (err) {
        throw new TaskSinkError('Google Tasks list failed', err);
      }
    },

    async complete(taskId, listId) {
      try {
        await tasksApi.tasks.patch({
          tasklist: listId,
          task: taskId,
          requestBody: { status: 'completed' },
        });
      } catch (err) {
        throw new TaskSinkError('Google Tasks complete failed', err);
      }
    },

    async delete(taskId, listId) {
      try {
        await tasksApi.tasks.delete({ tasklist: listId, task: taskId });
      } catch (err) {
        throw new TaskSinkError('Google Tasks delete failed', err);
      }
    },

    async snooze(taskId, listId, newDeadlineIso) {
      try {
        await tasksApi.tasks.patch({
          tasklist: listId,
          task: taskId,
          requestBody: { due: toDueDate(newDeadlineIso) ?? null },
        });
      } catch (err) {
        throw new TaskSinkError('Google Tasks snooze failed', err);
      }
    },

    async updateNotes(taskId, listId, notes) {
      try {
        await tasksApi.tasks.patch({
          tasklist: listId,
          task: taskId,
          requestBody: { notes: clampNotes(notes) },
        });
      } catch (err) {
        throw new TaskSinkError('Google Tasks updateNotes failed', err);
      }
    },

    async get(taskId, listId) {
      try {
        const res = await tasksApi.tasks.get({ tasklist: listId, task: taskId });
        return fromGoogle(res.data, listId);
      } catch (err) {
        logger.debug({ err, taskId }, 'google tasks: get failed');
        return null;
      }
    },
  };
}

import { logger } from '../lib/logger.js';
import type { Task } from '../schemas/task.schema.js';

export interface CreatedTask {
  id: string;
  listId: string;
  shortId: string;
}

export interface StoredTask {
  id: string;
  listId: string;
  title: string;
  notes: string | null;
  due: string | null;
  status: 'needsAction' | 'completed';
}

export interface TaskSink {
  create(task: Task): Promise<CreatedTask>;
  listOpen(limit?: number): Promise<StoredTask[]>;
  complete(taskId: string, listId: string): Promise<void>;
  delete(taskId: string, listId: string): Promise<void>;
  snooze(taskId: string, listId: string, newDeadlineIso: string): Promise<void>;
  updateNotes(taskId: string, listId: string, notes: string): Promise<void>;
  get(taskId: string, listId: string): Promise<StoredTask | null>;
}

/**
 * In-memory mock for local dev. Replaced by google-tasks sink in production.
 */
export function createConsoleTaskSink(): TaskSink {
  const store = new Map<string, StoredTask>();
  const DEFAULT_LIST = 'mock-list';

  return {
    async create(task) {
      const id = `mock-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const stored: StoredTask = {
        id,
        listId: DEFAULT_LIST,
        title: task.title,
        notes: task.description,
        due: task.deadline,
        status: 'needsAction',
      };
      store.set(id, stored);
      logger.info({ id, task }, 'createTask (mock)');
      return { id, listId: DEFAULT_LIST, shortId: id.slice(0, 8) };
    },
    async listOpen(limit = 10) {
      return Array.from(store.values())
        .filter((t) => t.status === 'needsAction')
        .slice(0, limit);
    },
    async complete(id) {
      const row = store.get(id);
      if (row) row.status = 'completed';
    },
    async delete(id) {
      store.delete(id);
    },
    async snooze(id, _listId, newDeadlineIso) {
      const row = store.get(id);
      if (row) row.due = newDeadlineIso;
    },
    async updateNotes(id, _listId, notes) {
      const row = store.get(id);
      if (row) row.notes = notes;
    },
    async get(id) {
      return store.get(id) ?? null;
    },
  };
}

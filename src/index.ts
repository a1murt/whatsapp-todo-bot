import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { createWhatsAppService } from './services/whatsapp.service.js';
import { createLLMService } from './services/llm.service.js';
import { createConsoleTaskSink, type TaskSink } from './services/task.service.js';
import { createGoogleTasksSink } from './services/google-tasks.service.js';
import { createScheduler } from './services/scheduler.service.js';
import { parseCommand, parseShortIdArg, formatTaskList } from './commands/command-router.js';
import { LLMExtractionError, TaskSinkError } from './schemas/errors.js';
import {
  activeRecurring,
  cancelRecurring,
  closeDb,
  deleteRemindersForTask,
  getClarification,
  getTaskByShortId,
  insertClarification,
  getStats,
  insertRecurring,
  insertReminder,
  listOpenTasks,
  markClarificationResolved,
  markTaskCompleted,
  markTaskDeleted,
  searchOpenTasks,
  updateTaskDeadline,
} from './lib/db.js';
import { parseWhen } from './lib/duration.js';
import { augmentTextWithUrls, enrichUrls, urlsAsNotes } from './lib/url-enricher.js';
import type { Task } from './schemas/task.schema.js';
import type pkg from 'whatsapp-web.js';

type WAMessage = pkg.Message;

const CLARIFY_REF_RE = /_ref #cl-([a-z0-9]{6})_/i;
const MAX_INPUT_LENGTH = 10_000;

function clampInput(text: string, log: { warn: (o: object, m: string) => void }): string {
  if (text.length <= MAX_INPUT_LENGTH) return text;
  log.warn(
    { originalLength: text.length, clampedTo: MAX_INPUT_LENGTH },
    'input exceeded limit — truncating',
  );
  return text.slice(0, MAX_INPUT_LENGTH) + '\n…[truncated]';
}

function buildSink(): TaskSink {
  if (env.TASK_SINK === 'console') {
    logger.warn('TASK_SINK=console — using in-memory mock sink');
    return createConsoleTaskSink();
  }
  try {
    return createGoogleTasksSink();
  } catch (err) {
    logger.error({ err }, 'Google Tasks sink unavailable — falling back to console mock');
    return createConsoleTaskSink();
  }
}

function extractTimeOfDay(iso: string, tz: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

function genClarifyRef(): string {
  return Math.random().toString(36).slice(2, 8);
}

async function main() {
  const wa = createWhatsAppService();
  const llm = createLLMService();
  const sink = buildSink();

  await wa.start();
  await wa.whenReady();

  const scheduler = createScheduler(wa, sink);
  scheduler.start();

  function scheduleDeadlineReminder(shortId: string, deadlineIso: string | null) {
    if (!deadlineIso) return;
    const deadline = new Date(deadlineIso);
    if (Number.isNaN(deadline.getTime())) return;
    const leadMs = env.REMINDER_LEAD_MINUTES * 60 * 1000;
    const remindAt = new Date(deadline.getTime() - leadMs);
    if (remindAt.getTime() <= Date.now()) return;
    insertReminder({
      short_id: shortId,
      remind_at: remindAt.toISOString(),
      kind: 'deadline',
    });
    logger.debug({ shortId, remindAt: remindAt.toISOString() }, 'reminder scheduled');
  }

  async function createAndReply(msg: WAMessage, task: Task): Promise<void> {
    const log = logger.child({ msgId: msg.id?._serialized });
    try {
      const created = await sink.create(task);
      scheduleDeadlineReminder(created.shortId, task.deadline);
      const parts: string[] = [`✅ ${task.title}`];
      if (task.deadline) {
        const d = new Date(task.deadline);
        if (!Number.isNaN(d.getTime())) {
          parts.push(
            '⏰ ' +
              new Intl.DateTimeFormat('ru-RU', {
                timeZone: env.TIMEZONE,
                day: '2-digit',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
              }).format(d),
          );
        }
      }
      if (task.priority === 'high') parts.push('🔥');
      if (task.listName) parts.push(`📁 ${task.listName}`);
      if (task.recurrence) parts.push(`🔁 ${task.recurrence}`);
      parts.push(`#${created.shortId}`);

      // dedup suggestion
      try {
        const open = listOpenTasks(40);
        const candidates = open
          .filter((t) => t.short_id !== created.shortId)
          .map((t) => ({ shortId: t.short_id, title: t.title }));
        if (candidates.length > 0) {
          const dup = await llm.findDuplicate(task.title, candidates);
          if (dup.matchShortId) {
            const match = open.find((t) => t.short_id === dup.matchShortId);
            if (match) {
              parts.push(`\n⚠️ похоже на #${match.short_id} «${match.title}» — /del если дубль`);
            }
          }
        }
      } catch (err) {
        log.debug({ err }, 'dedup check failed (non-fatal)');
      }

      await wa.replyTo(msg, parts.join('  '));
    } catch (err) {
      log.error({ err }, 'task sink create failed');
      const reason = err instanceof TaskSinkError ? err.message : 'save failed';
      await wa.replyTo(msg, `❌ ${reason}`);
    }
  }

  async function handleExtract(msg: WAMessage, text: string) {
    const log = logger.child({ msgId: msg.id?._serialized });
    if (!text.trim()) {
      await wa.replyTo(msg, 'Пустое сообщение — нечего сохранять.');
      return;
    }
    const clamped = clampInput(text, log);
    const enriched = await enrichUrls(clamped).catch(() => []);
    const augmented = enriched.length > 0 ? augmentTextWithUrls(clamped, enriched) : clamped;
    let task: Task;
    try {
      task = await llm.extractTask(augmented, new Date());
    } catch (err) {
      log.error({ err }, 'LLM extraction failed');
      const reason = err instanceof LLMExtractionError ? err.message : 'unexpected error';
      await wa.replyTo(msg, `⚠️ Не смог разобрать: ${reason}`);
      return;
    }
    log.info({ task }, 'extracted');
    if (!task.isTask) {
      log.debug('not a task — silent');
      return;
    }

    // Agentic follow-up: ask for missing detail before creating
    if (task.needsClarification && task.clarifyQuestion) {
      const ref = genClarifyRef();
      insertClarification(ref, text, task.clarifyQuestion, new Date().toISOString());
      await wa.replyTo(msg, `🤔 ${task.clarifyQuestion}\n\n_ref #cl-${ref}_`);
      return;
    }

    if (enriched.length > 0) {
      const urlBlock = urlsAsNotes(enriched);
      task.description = task.description ? `${task.description}\n\n${urlBlock}` : urlBlock;
    }

    // Register recurring template alongside creating the first instance
    if (task.recurrence) {
      try {
        insertRecurring({
          title: task.title,
          recurrence: task.recurrence,
          time_of_day: task.deadline ? extractTimeOfDay(task.deadline, env.TIMEZONE) : null,
          list_name: task.listName,
          priority: task.priority,
          created_at: new Date().toISOString(),
        });
        log.info({ recurrence: task.recurrence }, 'recurring template registered');
      } catch (err) {
        log.warn({ err }, 'recurring template insert failed (non-fatal)');
      }
    }

    await createAndReply(msg, task);
  }

  async function handleExtractBatch(msg: WAMessage, rest: string) {
    const log = logger.child({ msgId: msg.id?._serialized, kind: 'batch' });
    const aliases = env.USER_ALIASES;

    let text = rest.trim();
    if (msg.hasQuotedMsg) {
      try {
        const q = await msg.getQuotedMessage();
        const qb = q?.body?.trim() ?? '';
        if (qb) text = text ? `${qb}\n\n${text}` : qb;
      } catch (err) {
        log.debug({ err }, 'getQuotedMessage failed');
      }
    }
    if (!text) {
      await wa.replyTo(
        msg,
        'Формат: ответь `/extract` на пересланный чат, или вставь текст после команды.',
      );
      return;
    }
    if (aliases.length === 0) {
      log.warn('USER_ALIASES is empty — batch extraction may be noisy');
    }

    const clamped = clampInput(text, log);
    let batch;
    try {
      batch = await llm.extractTasksBatch(clamped, new Date(), aliases);
    } catch (err) {
      log.error({ err }, 'batch extract failed');
      await wa.replyTo(msg, '⚠️ Не смог разобрать чат.');
      return;
    }

    const tasks = batch.tasks.filter((t) => t.isTask && t.title.trim());
    if (tasks.length === 0) {
      await wa.replyTo(msg, '📭 Ничего на тебя в этом чате не нашёл.');
      return;
    }

    const lines: string[] = [];
    for (const task of tasks) {
      try {
        const created = await sink.create(task);
        scheduleDeadlineReminder(created.shortId, task.deadline);
        lines.push(`#${created.shortId}  ${task.title}`);
      } catch (err) {
        log.error({ err, task }, 'batch create failed');
      }
    }
    await wa.replyTo(msg, `📋 Создал ${lines.length} задач:\n${lines.join('\n')}`);
  }

  async function handleRecurringList(msg: WAMessage) {
    const active = activeRecurring();
    if (active.length === 0) {
      await wa.replyTo(msg, '🔁 Регулярных задач нет.');
      return;
    }
    const lines = active.map((r) => {
      const timeStr = r.time_of_day ? ` @ ${r.time_of_day}` : '';
      const listStr = r.list_name ? `  📁 ${r.list_name}` : '';
      return `#r${r.id}  ${r.title}  (${r.recurrence}${timeStr})${listStr}`;
    });
    await wa.replyTo(msg, `🔁 Регулярные:\n${lines.join('\n')}\n\nОтменить: /unsub #r<id>`);
  }

  async function handleUnsub(msg: WAMessage, rest: string) {
    const m = rest.match(/#r(\d+)/);
    if (!m || !m[1]) {
      await wa.replyTo(msg, 'Формат: /unsub #r<id> (id из /recurring)');
      return;
    }
    cancelRecurring(parseInt(m[1], 10), new Date().toISOString());
    await wa.replyTo(msg, '✅ Отменено.');
  }

  async function tryHandleClarifyReply(msg: WAMessage): Promise<boolean> {
    if (msg.type !== 'chat' || !msg.body?.trim() || !msg.hasQuotedMsg) return false;
    let quoted;
    try {
      quoted = await msg.getQuotedMessage();
    } catch {
      return false;
    }
    const qb = quoted?.body ?? '';
    const m = qb.match(CLARIFY_REF_RE);
    if (!m || !m[1]) return false;
    const ref = m[1];
    const row = getClarification(ref);
    if (!row) return false;
    markClarificationResolved(ref, new Date().toISOString());
    const merged = `${row.original}\n\nОтвет на уточнение «${row.question}»: ${msg.body.trim()}`;
    await handleExtract(msg, merged);
    return true;
  }

  async function buildContextualText(msg: WAMessage, text: string): Promise<string> {
    const parts: string[] = [];
    if (msg.isForwarded) parts.push('[Переслано]');
    try {
      if (msg.hasQuotedMsg) {
        const quoted = await msg.getQuotedMessage();
        const qb = quoted?.body?.trim();
        if (qb) parts.push(`> ${qb.slice(0, 500).replace(/\n/g, '\n> ')}`);
      }
    } catch (err) {
      logger.debug({ err }, 'getQuotedMessage failed');
    }
    if (parts.length === 0) return text;
    return `${parts.join('\n')}\n\n${text}`;
  }

  async function handleStats(msg: WAMessage) {
    const stats = getStats(new Date());
    const fmt = new Intl.DateTimeFormat('ru-RU', {
      timeZone: env.TIMEZONE,
      day: '2-digit',
      month: 'short',
    });
    const lines: string[] = [
      '📊 *Статистика за неделю*',
      '',
      `📝 Открытых: ${stats.openCount}`,
      `✅ Закрыто за 7 дней: ${stats.closedThisWeek}`,
      `🔥 Просрочено: ${stats.overdueCount}`,
    ];
    if (stats.oldestOpen.length > 0) {
      lines.push('', '⏳ *Самые старые открытые:*');
      for (const t of stats.oldestOpen) {
        const age = Math.max(
          0,
          Math.floor((Date.now() - new Date(t.created_at).getTime()) / 86_400_000),
        );
        const d = fmt.format(new Date(t.created_at));
        lines.push(`• ${t.title}  (${d}, ${age}д)  #${t.short_id}`);
      }
    }
    await wa.replyTo(msg, lines.join('\n'));
  }

  async function handleSearch(msg: WAMessage, rest: string) {
    const query = rest.trim();
    if (!query) {
      await wa.replyTo(msg, 'Формат: `/search <запрос>` — найдёт по открытым задачам.');
      return;
    }
    const rows = searchOpenTasks(query, 10);
    if (rows.length === 0) {
      await wa.replyTo(msg, `🔍 По запросу «${query}» ничего не найдено.`);
      return;
    }
    const fmt = new Intl.DateTimeFormat('ru-RU', {
      timeZone: env.TIMEZONE,
      day: '2-digit',
      month: 'short',
    });
    const lines = rows.map((r, i) => {
      const n = String(i + 1).padStart(2, ' ');
      const due = r.deadline ? `  ⏰ ${fmt.format(new Date(r.deadline))}` : '';
      return `${n}. ${r.title}${due}  #${r.short_id}`;
    });
    await wa.replyTo(msg, `🔍 Найдено ${rows.length} по «${query}»:\n${lines.join('\n')}`);
  }

  async function handleHelp(msg: WAMessage) {
    const body = [
      '📖 *Команды:*',
      '',
      '`/todo <текст>` — принудительно создать задачу',
      '`/list [N]` — открытые задачи (по умолчанию 10)',
      '`/done #<id>` — закрыть задачу',
      '`/del #<id>` — удалить задачу',
      '`/snooze #<id> 2h` — перенести (m/h/d/w)',
      '`/search <запрос>` — поиск по открытым задачам',
      '`/stats` — статистика за неделю',
      '`/extract` — вытащить мои задачи из пересланного чата',
      '`/recurring` — повторяющиеся задачи',
      '`/unsub #r<id>` — отменить повтор',
      '`/help` — это меню',
      '',
      '📝 В self-chat любой текст, голосовое или картинка → задача.',
      '🤔 Если бот спрашивает уточнение — ответь цитатой на его вопрос.',
    ].join('\n');
    await wa.replyTo(msg, body);
  }

  async function handleList(msg: WAMessage, rest: string) {
    const log = logger.child({ msgId: msg.id?._serialized });
    const limitArg = parseInt(rest, 10);
    const limit = Number.isFinite(limitArg) && limitArg > 0 ? limitArg : 10;
    try {
      const items = await sink.listOpen(limit);
      await wa.replyTo(msg, formatTaskList(items, env.TIMEZONE));
    } catch (err) {
      log.error({ err }, 'list failed');
      const reason = err instanceof TaskSinkError ? err.message : 'list failed';
      await wa.replyTo(msg, `❌ ${reason}`);
    }
  }

  async function handleDone(msg: WAMessage, rest: string) {
    const { shortId } = parseShortIdArg(rest);
    if (!shortId) {
      await wa.replyTo(msg, 'Укажи id: `/done #a3f2b1c4`');
      return;
    }
    const row = getTaskByShortId(shortId);
    if (!row) {
      await wa.replyTo(msg, `Не нашёл задачу с id \`#${shortId}\`.`);
      return;
    }
    try {
      await sink.complete(row.google_task_id, row.list_id);
      markTaskCompleted(shortId, new Date().toISOString());
      deleteRemindersForTask(shortId);
      await wa.replyTo(msg, `✔ Закрыто: ${row.title}`);
    } catch (err) {
      logger.error({ err, shortId }, 'complete failed');
      const reason = err instanceof TaskSinkError ? err.message : 'complete failed';
      await wa.replyTo(msg, `❌ ${reason}`);
    }
  }

  async function handleDel(msg: WAMessage, rest: string) {
    const { shortId } = parseShortIdArg(rest);
    if (!shortId) {
      await wa.replyTo(msg, 'Укажи id: `/del #a3f2b1c4`');
      return;
    }
    const row = getTaskByShortId(shortId);
    if (!row) {
      await wa.replyTo(msg, `Не нашёл задачу с id \`#${shortId}\`.`);
      return;
    }
    try {
      await sink.delete(row.google_task_id, row.list_id);
      markTaskDeleted(shortId, new Date().toISOString());
      deleteRemindersForTask(shortId);
      await wa.replyTo(msg, `🗑 Удалено: ${row.title}`);
    } catch (err) {
      logger.error({ err, shortId }, 'delete failed');
      const reason = err instanceof TaskSinkError ? err.message : 'delete failed';
      await wa.replyTo(msg, `❌ ${reason}`);
    }
  }

  async function handleSnooze(msg: WAMessage, rest: string) {
    const { shortId, remainder } = parseShortIdArg(rest);
    if (!shortId || !remainder) {
      await wa.replyTo(msg, 'Формат: `/snooze #a3f2b1c4 2h` (m/h/d/w)');
      return;
    }
    const row = getTaskByShortId(shortId);
    if (!row) {
      await wa.replyTo(msg, `Не нашёл задачу с id \`#${shortId}\`.`);
      return;
    }
    const target = parseWhen(remainder, new Date(), env.TIMEZONE);
    if (!target) {
      await wa.replyTo(
        msg,
        'Не понял время. Примеры: `2h`, `30m`, `1d`, `17:00`, `завтра 9`, `понедельник 10`.',
      );
      return;
    }
    const iso = target.toISOString();
    try {
      await sink.snooze(row.google_task_id, row.list_id, iso);
      updateTaskDeadline(shortId, iso);
      deleteRemindersForTask(shortId);
      const leadMs = env.REMINDER_LEAD_MINUTES * 60 * 1000;
      const remindAt = new Date(target.getTime() - leadMs);
      if (remindAt.getTime() > Date.now()) {
        insertReminder({
          short_id: shortId,
          remind_at: remindAt.toISOString(),
          kind: 'deadline',
        });
      }
      const fmt = new Intl.DateTimeFormat('ru-RU', {
        timeZone: env.TIMEZONE,
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }).format(target);
      await wa.replyTo(msg, `⏭ Перенесено: ${row.title}  ⏰ ${fmt}`);
    } catch (err) {
      logger.error({ err, shortId }, 'snooze failed');
      const reason = err instanceof TaskSinkError ? err.message : 'snooze failed';
      await wa.replyTo(msg, `❌ ${reason}`);
    }
  }

  async function handleVoice(msg: WAMessage) {
    const log = logger.child({ msgId: msg.id?._serialized, kind: 'voice' });
    let media;
    try {
      media = await msg.downloadMedia();
    } catch (err) {
      log.error({ err }, 'downloadMedia failed');
      await wa.replyTo(msg, '⚠️ Не удалось скачать голосовое сообщение.');
      return;
    }
    if (!media) {
      await wa.replyTo(msg, '⚠️ Голосовое сообщение не доступно (не загрузилось).');
      return;
    }
    const buffer = Buffer.from(media.data, 'base64');
    let transcript: string;
    try {
      transcript = await llm.transcribeAudio(buffer, media.mimetype);
    } catch (err) {
      log.error({ err }, 'whisper failed');
      await wa.replyTo(msg, '⚠️ Не смог распознать голос.');
      return;
    }
    log.info({ transcript }, 'transcribed');
    await wa.replyTo(msg, `🎤 «${transcript}»`);
    return handleExtract(msg, transcript);
  }

  async function handleImage(msg: WAMessage) {
    const log = logger.child({ msgId: msg.id?._serialized, kind: 'image' });
    let media;
    try {
      media = await msg.downloadMedia();
    } catch (err) {
      log.error({ err }, 'downloadMedia failed');
      await wa.replyTo(msg, '⚠️ Не удалось скачать картинку.');
      return;
    }
    if (!media) {
      await wa.replyTo(msg, '⚠️ Картинка не доступна.');
      return;
    }
    let task: Task;
    try {
      task = await llm.extractTaskFromImage(media.data, media.mimetype, new Date());
    } catch (err) {
      log.error({ err }, 'vision failed');
      const reason = err instanceof LLMExtractionError ? err.message : 'vision error';
      await wa.replyTo(msg, `⚠️ Не смог разобрать картинку: ${reason}`);
      return;
    }
    log.info({ task }, 'vision extracted');
    if (!task.isTask) {
      log.debug('image → not a task');
      return;
    }
    if (task.needsClarification && task.clarifyQuestion) {
      const ref = genClarifyRef();
      insertClarification(ref, '[image]', task.clarifyQuestion, new Date().toISOString());
      await wa.replyTo(msg, `🤔 ${task.clarifyQuestion}\n\n_ref #cl-${ref}_`);
      return;
    }
    if (task.recurrence) {
      insertRecurring({
        title: task.title,
        recurrence: task.recurrence,
        time_of_day: task.deadline ? extractTimeOfDay(task.deadline, env.TIMEZONE) : null,
        list_name: task.listName,
        priority: task.priority,
        created_at: new Date().toISOString(),
      });
    }
    await createAndReply(msg, task);
  }

  wa.onMessage(async (msg) => {
    const isSelfChat = await wa.isSelfChat(msg);
    if (!isSelfChat) return;

    // Priority 1: clarification reply (text with quoted bot msg containing ref)
    if (await tryHandleClarifyReply(msg)) return;

    if (msg.type === 'chat' && msg.body?.trim()) {
      const command = parseCommand(msg.body);
      if (command) {
        switch (command.name) {
          case 'list':
          case 'задачи':
          case 'список':
            return handleList(msg, command.rest);
          case 'todo':
          case 'тудо':
            return handleExtract(msg, command.rest);
          case 'done':
          case 'готово':
            return handleDone(msg, command.rest);
          case 'del':
          case 'delete':
          case 'удалить':
            return handleDel(msg, command.rest);
          case 'snooze':
          case 'отложить':
            return handleSnooze(msg, command.rest);
          case 'extract':
          case 'вытащи':
            return handleExtractBatch(msg, command.rest);
          case 'recurring':
          case 'регулярные':
            return handleRecurringList(msg);
          case 'unsub':
          case 'отписаться':
            return handleUnsub(msg, command.rest);
          case 'help':
          case 'помощь':
          case 'хелп':
            return handleHelp(msg);
          case 'search':
          case 'поиск':
          case 'найти':
            return handleSearch(msg, command.rest);
          case 'stats':
          case 'статистика':
          case 'стата':
            return handleStats(msg);
          default:
            return;
        }
      }
      const enriched = await buildContextualText(msg, msg.body);
      return handleExtract(msg, enriched);
    }

    if (msg.type === 'ptt' || msg.type === 'audio') {
      return handleVoice(msg);
    }
    if (msg.type === 'image') {
      return handleImage(msg);
    }
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutdown signal');
    scheduler.stop();
    await wa.stop();
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'fatal during startup');
  process.exit(1);
});

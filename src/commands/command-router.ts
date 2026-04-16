export interface ParsedCommand {
  name: string;
  rest: string;
}

// `\b` would break on Unicode letters (e.g. Cyrillic `/задачи 5`), so we rely
// on the character class stopping at whitespace instead.
const COMMAND_RE = /^\/(\p{L}[\p{L}\p{N}_-]*)\s*([\s\S]*)$/u;

export function parseCommand(body: string): ParsedCommand | null {
  const m = body.trim().match(COMMAND_RE);
  if (!m || !m[1]) return null;
  return { name: m[1].toLowerCase(), rest: (m[2] ?? '').trim() };
}

/**
 * Extract the first `#<shortid>` token from a command argument. Returns the
 * alphanumeric id (without `#`) or null when missing.
 */
export function parseShortIdArg(rest: string): { shortId: string | null; remainder: string } {
  const m = rest.match(/#([a-zA-Z0-9]{4,32})/);
  if (!m || !m[1]) return { shortId: null, remainder: rest.trim() };
  const remainder = (rest.slice(0, m.index) + rest.slice((m.index ?? 0) + m[0].length)).trim();
  return { shortId: m[1], remainder };
}

export function formatTaskList(items: Array<{ title: string; due: string | null }>, tz: string): string {
  if (items.length === 0) return '📋 Задач нет. Свободен 🏖️';
  const fmt = new Intl.DateTimeFormat('ru-RU', {
    timeZone: tz,
    day: '2-digit',
    month: 'short',
  });
  const lines = items.map((t, i) => {
    const n = String(i + 1).padStart(2, ' ');
    const due = t.due ? `  ⏰ ${fmt.format(new Date(t.due))}` : '';
    return `${n}. ${t.title}${due}`;
  });
  return `📋 Задачи (${items.length}):\n${lines.join('\n')}`;
}

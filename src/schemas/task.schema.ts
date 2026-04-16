import { z } from 'zod';

export const TaskSchema = z.object({
  isTask: z
    .boolean()
    .describe('true only if the message contains an actionable to-do'),
  title: z
    .string()
    .describe(
      'Short imperative title in the source language, max 140 chars. Empty string when isTask=false.',
    ),
  description: z
    .string()
    .nullable()
    .describe('Extra context (who/where/why) or null when none.'),
  deadline: z
    .string()
    .nullable()
    .describe(
      'ISO-8601 datetime with timezone offset, resolved against NOW. null when no time reference.',
    ),
  priority: z
    .enum(['low', 'medium', 'high'])
    .describe('Default medium. high for urgency words or deadline within 24h.'),
  sourceLang: z
    .enum(['ru', 'en', 'mixed', 'other'])
    .describe('Detected primary language of the input.'),
  listName: z
    .string()
    .nullable()
    .describe(
      'Optional Google Tasks list name extracted from a leading/trailing #tag in the message (e.g. "#работа" → "работа"). null when no tag is present.',
    ),
  recurrence: z
    .string()
    .nullable()
    .describe(
      'Recurrence pattern when the message describes a repeating task. One of: "daily", "weekdays", "weekly:mon|tue|wed|thu|fri|sat|sun", "monthly:<1-31>", "yearly:<MM-DD>". null otherwise. Detect phrases like "каждый понедельник" (weekly:mon), "ежедневно" (daily), "по будням" (weekdays), "каждое 15 число" (monthly:15), "каждый год 8 марта" (yearly:03-08).',
    ),
  needsClarification: z
    .boolean()
    .describe(
      'true when the task is too vague to create without a follow-up question — missing critical info like "who", "when", or "what exactly". Only set true for genuinely ambiguous tasks, not normal ones without deadlines.',
    ),
  clarifyQuestion: z
    .string()
    .nullable()
    .describe(
      'A single short clarifying question in the user\'s source language. null when needsClarification=false.',
    ),
});

export type Task = z.infer<typeof TaskSchema>;

export const BatchTasksSchema = z.object({
  tasks: z
    .array(TaskSchema)
    .describe('Extracted tasks — may be empty when nothing is assigned to the user.'),
});
export type BatchTasks = z.infer<typeof BatchTasksSchema>;

export const DuplicateMatchSchema = z.object({
  matchShortId: z
    .string()
    .nullable()
    .describe('Short id of an existing task that is essentially the same; null if none.'),
  reason: z
    .string()
    .nullable()
    .describe('One short sentence why it matches, or null.'),
});
export type DuplicateMatch = z.infer<typeof DuplicateMatchSchema>;

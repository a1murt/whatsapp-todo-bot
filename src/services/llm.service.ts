import OpenAI, { toFile } from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { withRetry } from '../lib/retry.js';
import { LLMExtractionError } from '../schemas/errors.js';
import {
  BatchTasksSchema,
  DuplicateMatchSchema,
  TaskSchema,
  type BatchTasks,
  type DuplicateMatch,
  type Task,
} from '../schemas/task.schema.js';
import {
  buildBatchExtractionPrompt,
  buildDedupPrompt,
  buildSystemPrompt,
} from '../prompts/task-extraction.prompt.js';

export interface LLMService {
  extractTask(text: string, now: Date): Promise<Task>;
  transcribeAudio(buffer: Buffer, mimetype: string): Promise<string>;
  extractTaskFromImage(base64: string, mimetype: string, now: Date): Promise<Task>;
  extractTasksBatch(text: string, now: Date, aliases: readonly string[]): Promise<BatchTasks>;
  findDuplicate(
    newTitle: string,
    candidates: Array<{ shortId: string; title: string }>,
  ): Promise<DuplicateMatch>;
}

function extForMimetype(mimetype: string): string {
  const sub = mimetype.split('/')[1]?.split(';')[0]?.trim() ?? 'ogg';
  // Whisper accepts: flac, m4a, mp3, mp4, mpeg, mpga, oga, ogg, wav, webm
  if (sub === 'mpeg' || sub === 'mp4a-latm') return 'mp3';
  if (sub === 'x-m4a') return 'm4a';
  return sub;
}

export function createLLMService(): LLMService {
  const client = new OpenAI({
    apiKey: env.OPENAI_API_KEY,
    ...(env.OPENAI_BASE_URL ? { baseURL: env.OPENAI_BASE_URL } : {}),
  });

  return {
    async extractTask(text, now) {
      const system = buildSystemPrompt(now, env.TIMEZONE);

      const completion = await withRetry(
        () =>
          client.chat.completions.parse({
            model: env.OPENAI_MODEL,
            temperature: 0,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: text },
            ],
            response_format: zodResponseFormat(TaskSchema, 'task'),
          }),
        {
          attempts: 2,
          baseMs: 500,
          onRetry: (err, attempt) =>
            logger.warn({ err, attempt }, 'LLM call failed, retrying'),
        },
      );

      const choice = completion.choices[0];
      if (!choice) {
        throw new LLMExtractionError('No choices returned by model');
      }
      if (choice.finish_reason === 'length') {
        throw new LLMExtractionError('Model output truncated (length)');
      }
      const parsed = choice.message.parsed;
      if (!parsed) {
        throw new LLMExtractionError(
          choice.message.refusal
            ? `Model refused: ${choice.message.refusal}`
            : 'Model returned null parsed object',
        );
      }
      return parsed;
    },

    async transcribeAudio(buffer, mimetype) {
      const ext = extForMimetype(mimetype);
      const file = await toFile(buffer, `audio.${ext}`, { type: mimetype });
      const res = await withRetry(
        () =>
          client.audio.transcriptions.create({
            file,
            model: env.WHISPER_MODEL,
            // Let Whisper auto-detect language (ru/en/kk all supported)
          }),
        {
          attempts: 2,
          baseMs: 800,
          onRetry: (err, attempt) =>
            logger.warn({ err, attempt }, 'Whisper call failed, retrying'),
        },
      );
      const text = (res as { text?: string }).text?.trim() ?? '';
      if (!text) throw new LLMExtractionError('Whisper returned empty transcript');
      return text;
    },

    async extractTasksBatch(text, now, aliases) {
      const system = buildBatchExtractionPrompt(now, env.TIMEZONE, aliases);
      const completion = await withRetry(
        () =>
          client.chat.completions.parse({
            model: env.OPENAI_MODEL,
            temperature: 0,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: text },
            ],
            response_format: zodResponseFormat(BatchTasksSchema, 'batch'),
          }),
        {
          attempts: 2,
          baseMs: 500,
          onRetry: (err, attempt) =>
            logger.warn({ err, attempt }, 'batch extract failed, retrying'),
        },
      );
      const choice = completion.choices[0];
      if (!choice) throw new LLMExtractionError('batch: no choices');
      if (choice.finish_reason === 'length') {
        throw new LLMExtractionError('batch: truncated');
      }
      const parsed = choice.message.parsed;
      if (!parsed) {
        throw new LLMExtractionError(
          choice.message.refusal
            ? `batch refused: ${choice.message.refusal}`
            : 'batch: null parsed',
        );
      }
      return parsed;
    },

    async findDuplicate(newTitle, candidates) {
      if (candidates.length === 0) return { matchShortId: null, reason: null };
      const system = buildDedupPrompt();
      const list = candidates
        .slice(0, 40)
        .map((c) => `- ${c.shortId}: ${c.title}`)
        .join('\n');
      const user = `New task: "${newTitle}"\n\nExisting open tasks:\n${list}`;
      try {
        const completion = await client.chat.completions.parse({
          model: env.OPENAI_MODEL,
          temperature: 0,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          response_format: zodResponseFormat(DuplicateMatchSchema, 'dup'),
        });
        const parsed = completion.choices[0]?.message.parsed;
        if (!parsed) return { matchShortId: null, reason: null };
        // defensive: id must be in candidate list
        if (parsed.matchShortId && !candidates.some((c) => c.shortId === parsed.matchShortId)) {
          return { matchShortId: null, reason: null };
        }
        return parsed;
      } catch (err) {
        logger.warn({ err }, 'findDuplicate failed');
        return { matchShortId: null, reason: null };
      }
    },

    async extractTaskFromImage(base64, mimetype, now) {
      const system = buildSystemPrompt(now, env.TIMEZONE);
      const userText =
        'The attached image is a photo, screenshot, or handwritten note from the user. ' +
        'Read any text/intent from it and extract a task following the schema.';
      const dataUrl = `data:${mimetype};base64,${base64}`;

      const completion = await withRetry(
        () =>
          client.chat.completions.parse({
            model: env.VISION_MODEL,
            temperature: 0,
            messages: [
              { role: 'system', content: system },
              {
                role: 'user',
                content: [
                  { type: 'text', text: userText },
                  { type: 'image_url', image_url: { url: dataUrl } },
                ],
              },
            ],
            response_format: zodResponseFormat(TaskSchema, 'task'),
          }),
        {
          attempts: 2,
          baseMs: 500,
          onRetry: (err, attempt) =>
            logger.warn({ err, attempt }, 'Vision call failed, retrying'),
        },
      );

      const choice = completion.choices[0];
      if (!choice) throw new LLMExtractionError('Vision returned no choices');
      if (choice.finish_reason === 'length') {
        throw new LLMExtractionError('Vision output truncated (length)');
      }
      const parsed = choice.message.parsed;
      if (!parsed) {
        throw new LLMExtractionError(
          choice.message.refusal
            ? `Vision refused: ${choice.message.refusal}`
            : 'Vision returned null parsed object',
        );
      }
      return parsed;
    },
  };
}

import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
  OPENAI_BASE_URL: z.string().url().optional(),
  OPENAI_MODEL: z.string().default('llama-3.3-70b-versatile'),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REFRESH_TOKEN: z.string().optional(),
  GOOGLE_TASKLIST_ID: z.string().default('@default'),

  TASK_SINK: z.enum(['google', 'console']).default('google'),

  DB_PATH: z.string().default('/app/data/bot.db'),

  WHISPER_MODEL: z.string().default('whisper-1'),
  VISION_MODEL: z.string().default('gpt-4o-mini'),

  DIGEST_HOUR: z.coerce.number().int().min(0).max(23).default(9),
  REMINDER_LEAD_MINUTES: z.coerce.number().int().min(0).default(30),

  TIMEZONE: z.string().default('UTC'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  USER_ALIASES: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter((x) => x.length > 0),
    ),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('[env] Invalid environment:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;

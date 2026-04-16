import pino, { type LoggerOptions } from 'pino';
import { env } from '../config/env.js';

const opts: LoggerOptions = { level: env.LOG_LEVEL };
if (process.stdout.isTTY) {
  opts.transport = {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
  };
}

export const logger = pino(opts);

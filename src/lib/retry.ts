export interface RetryOptions {
  attempts: number;
  baseMs: number;
  factor?: number;
  onRetry?: (err: unknown, attempt: number) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const factor = opts.factor ?? 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === opts.attempts) break;
      opts.onRetry?.(err, attempt);
      await sleep(opts.baseMs * Math.pow(factor, attempt - 1));
    }
  }
  throw lastErr;
}

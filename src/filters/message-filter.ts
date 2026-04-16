import type { Message } from 'whatsapp-web.js';

export interface FilterContext {
  selfWid: string;
  triggers: string[];
}

export function shouldProcess(msg: Message, ctx: FilterContext): boolean {
  if (msg.type !== 'chat') return false;
  if (!msg.body || !msg.body.trim()) return false;

  const isSelfChat = msg.fromMe && msg.to === ctx.selfWid;
  const lower = msg.body.trim().toLowerCase();
  const hasTrigger = ctx.triggers.some((t) => lower.startsWith(t.toLowerCase()));

  return isSelfChat || hasTrigger;
}

export function stripTrigger(body: string, triggers: string[]): string {
  const trimmed = body.trim();
  const lower = trimmed.toLowerCase();
  for (const t of triggers) {
    if (lower.startsWith(t.toLowerCase())) {
      return trimmed.slice(t.length).trim();
    }
  }
  return trimmed;
}

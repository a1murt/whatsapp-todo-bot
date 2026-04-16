import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { logger } from '../lib/logger.js';

const { Client, LocalAuth } = pkg;
type WAClient = InstanceType<typeof Client>;
type Message = pkg.Message;

/** Zero-width space prepended to every bot reply. Lets us recognise our own
 *  messages synchronously in the event listener — immune to the race where
 *  `message_create` fires before `msg.reply()` resolves its id. */
export const BOT_REPLY_MARKER = '\u200B';

export interface WhatsAppService {
  client: WAClient;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Resolved on `ready`. selfWid = your @c.us wid. selfChatId = chat id of the "Message yourself" chat (often @lid). */
  whenReady(): Promise<{ selfWid: string; selfChatId: string | null }>;
  onMessage(handler: (msg: Message) => void | Promise<void>): void;
  isSelfChat(msg: Message): Promise<boolean>;
  /** Reply to a specific message (as quote). Applies BOT_REPLY_MARKER + tracks id to suppress self-loop. */
  replyTo(msg: Message, body: string): Promise<void>;
  /** Proactive message into the user's self-chat (reminders, digest). */
  notifySelf(body: string): Promise<void>;
}

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 5000;
const BOT_SENT_ID_CAP = 500;

export function createWhatsAppService(): WhatsAppService {
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: 'personal-todo' }),
    puppeteer: {
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  });

  let reconnectAttempts = 0;
  let messageHandler: ((msg: Message) => void | Promise<void>) | null = null;

  let cachedSelfChatId: string | null = null;
  const botSentIds = new Set<string>();
  const rememberBotSent = (id: string | undefined) => {
    if (!id) return;
    botSentIds.add(id);
    if (botSentIds.size > BOT_SENT_ID_CAP) {
      const first = botSentIds.values().next().value;
      if (first) botSentIds.delete(first);
    }
  };

  async function resolveSelfChatId(): Promise<string | null> {
    try {
      const chats = await client.getChats();
      for (const chat of chats) {
        try {
          const contact = await chat.getContact();
          if (contact.isMe) return chat.id._serialized;
        } catch {
          /* keep scanning */
        }
      }
    } catch (err) {
      logger.warn({ err }, 'resolveSelfChatId failed');
    }
    return null;
  }

  const readyPromise = new Promise<{ selfWid: string; selfChatId: string | null }>(
    (resolve, reject) => {
      client.once('ready', async () => {
        const selfWid = client.info?.wid?._serialized;
        if (!selfWid) {
          reject(new Error('client.info.wid missing on ready'));
          return;
        }
        cachedSelfChatId = await resolveSelfChatId();
        logger.info({ selfWid, selfChatId: cachedSelfChatId }, 'WhatsApp client ready');
        reconnectAttempts = 0;
        resolve({ selfWid, selfChatId: cachedSelfChatId });
      });
      client.once('auth_failure', (reason) => {
        reject(new Error(`auth_failure: ${reason}`));
      });
    },
  );

  client.on('qr', (qr) => {
    logger.info('Scan QR code with WhatsApp → Linked Devices');
    qrcode.generate(qr, { small: true });
  });

  client.on('authenticated', () => logger.info('Authenticated'));

  client.on('change_state', (state) => logger.debug({ state }, 'state changed'));

  client.on('auth_failure', (reason) => {
    logger.fatal({ reason }, 'auth_failure — clear .wwebjs_auth/ and rescan');
    process.exit(1);
  });

  client.on('disconnected', async (reason) => {
    logger.warn({ reason }, 'disconnected');
    try {
      await client.destroy();
    } catch (err) {
      logger.error({ err }, 'error during destroy after disconnect');
    }
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      logger.fatal({ reconnectAttempts }, 'max reconnect attempts reached, exiting');
      process.exit(1);
    }
    reconnectAttempts += 1;
    logger.info(
      { delayMs: RECONNECT_DELAY_MS, attempt: reconnectAttempts },
      'reconnecting…',
    );
    setTimeout(() => {
      client.initialize().catch((err) => {
        logger.error({ err }, 're-initialize failed');
      });
    }, RECONNECT_DELAY_MS);
  });

  // Use message_create (not "message"): "message" silently skips fromMe,
  // which would break the self-chat path.
  client.on('message_create', (msg) => {
    if (msg.body && msg.body.startsWith(BOT_REPLY_MARKER)) {
      logger.debug({ msgId: msg.id?._serialized }, 'skip — bot marker');
      return;
    }
    const msgId = msg.id?._serialized;
    if (msgId && botSentIds.has(msgId)) {
      logger.debug({ msgId }, 'skip — our own reply id');
      return;
    }
    logger.debug(
      {
        msgId,
        type: msg.type,
        fromMe: msg.fromMe,
        from: msg.from,
        to: msg.to,
        bodyPreview: msg.body?.slice(0, 60),
      },
      'message_create',
    );
    if (!messageHandler) return;
    Promise.resolve(messageHandler(msg)).catch((err) =>
      logger.error({ err, msgId }, 'message handler threw'),
    );
  });

  return {
    client,
    async start() {
      logger.info('initializing WhatsApp client…');
      await client.initialize();
    },
    async stop() {
      logger.info('shutting down WhatsApp client…');
      try {
        await client.destroy();
      } catch (err) {
        logger.error({ err }, 'error during shutdown');
      }
    },
    whenReady() {
      return readyPromise;
    },
    onMessage(handler) {
      messageHandler = handler;
    },
    // Authoritative self-chat detector. Uses cached chat id first (fast path),
    // falls back to contact lookup for resilience against id-format drift.
    async isSelfChat(msg) {
      if (!msg.fromMe) return false;
      // Only check msg.to — msg.from is ALWAYS our own WID for outgoing messages,
      // so checking it would make every outgoing message look like self-chat.
      if (cachedSelfChatId && msg.to === cachedSelfChatId) {
        return true;
      }
      try {
        const chat = await msg.getChat();
        const contact = await chat.getContact();
        return Boolean(contact.isMe);
      } catch {
        return false;
      }
    },
    async replyTo(msg, body) {
      try {
        const sent = (await msg.reply(BOT_REPLY_MARKER + body)) as
          | { id?: { _serialized?: string } }
          | undefined;
        rememberBotSent(sent?.id?._serialized);
      } catch (err) {
        logger.error({ err }, 'failed to reply');
      }
    },
    async notifySelf(body) {
      if (!cachedSelfChatId) {
        logger.warn('notifySelf called before selfChatId resolved — dropping');
        return;
      }
      try {
        const sent = (await client.sendMessage(cachedSelfChatId, BOT_REPLY_MARKER + body)) as
          | { id?: { _serialized?: string } }
          | undefined;
        rememberBotSent(sent?.id?._serialized);
      } catch (err) {
        logger.error({ err }, 'failed to notifySelf');
      }
    },
  };
}

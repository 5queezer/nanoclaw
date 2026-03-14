import path from 'path';
import https from 'https';
import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, DATA_DIR, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  downloadFile,
  getTelegramFileUrl,
  getFileExtension,
} from '../file-downloader.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  /**
   * Download a Telegram file by file_id and return the local path.
   * Returns null on any failure (graceful degradation).
   */
  private async downloadTelegramFile(
    fileId: string,
    chatJid: string,
    messageId: string,
    mimeType?: string,
  ): Promise<string | null> {
    if (!this.bot) return null;
    try {
      const fileInfo = await this.bot.api.getFile(fileId);
      if (!fileInfo.file_path) {
        logger.warn({ fileId }, 'Telegram getFile returned no file_path');
        return null;
      }

      // Check file size before downloading (file_size may not always be present)
      const MAX_SIZE = 20 * 1024 * 1024; // 20MB
      if (fileInfo.file_size && fileInfo.file_size > MAX_SIZE) {
        logger.warn(
          { fileId, size: fileInfo.file_size },
          'Telegram file too large (>20MB), skipping download',
        );
        return null;
      }

      const ext = getFileExtension(fileInfo.file_path, mimeType);
      const safeJid = chatJid.replace(/[^a-zA-Z0-9_-]/g, '_');
      const destPath = path.join(
        DATA_DIR,
        'media',
        safeJid,
        `${messageId}.${ext}`,
      );

      const url = getTelegramFileUrl(this.botToken, fileInfo.file_path);
      const localPath = await downloadFile(url, destPath);

      if (localPath) {
        logger.info(
          { fileId, localPath },
          'Telegram media file downloaded successfully',
        );
      }
      return localPath;
    } catch (err) {
      logger.warn({ fileId, err }, 'Failed to download Telegram media file');
      return null;
    }
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Helper to build common message fields from a Telegram context
    const buildBaseFields = (ctx: any) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const sender = ctx.from?.id?.toString() || '';
      const msgId = ctx.message.message_id.toString();
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      return { chatJid, timestamp, senderName, sender, msgId, caption, isGroup };
    };

    /**
     * Download a media file and deliver the message with the local path embedded
     * in the content string. Falls back to the placeholder if download fails.
     */
    const storeWithDownload = async (
      ctx: any,
      fileId: string,
      placeholder: string,
      mimeType?: string,
    ) => {
      const { chatJid, timestamp, senderName, sender, msgId, caption, isGroup } =
        buildBaseFields(ctx);

      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      // Attempt to download; fall back gracefully
      const localPath = await this.downloadTelegramFile(
        fileId,
        chatJid,
        msgId,
        mimeType,
      );

      let content: string;
      let attachments: string[] | undefined;

      if (localPath) {
        // Extract the label from placeholder e.g. "[Photo]" -> "Photo"
        const label = placeholder.replace(/^\[/, '').replace(/\]$/, '');
        content = `[${label}: ${localPath}]${caption}`;
        attachments = [localPath];
      } else {
        content = `${placeholder}${caption}`;
      }

      const msg: NewMessage = {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        attachments,
      };

      this.opts.onMessage(chatJid, msg);
    };

    /**
     * Fallback for media types that don't need downloading
     * (stickers, location, contact).
     */
    const storeNonText = (ctx: any, placeholder: string) => {
      const { chatJid, timestamp, senderName, sender, msgId, caption, isGroup } =
        buildBaseFields(ctx);

      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', async (ctx) => {
      // Use the last (highest quality) photo size
      const photos: Array<{ file_id: string }> | undefined = ctx.message.photo;
      const photo = photos && photos.length > 0 ? photos[photos.length - 1] : undefined;
      if (photo?.file_id) {
        await storeWithDownload(ctx, photo.file_id, '[Photo]', 'image/jpeg');
      } else {
        storeNonText(ctx, '[Photo]');
      }
    });

    this.bot.on('message:video', async (ctx) => {
      const video: { file_id: string; mime_type?: string } | undefined =
        ctx.message.video;
      if (video?.file_id) {
        await storeWithDownload(ctx, video.file_id, '[Video]', video.mime_type);
      } else {
        storeNonText(ctx, '[Video]');
      }
    });

    this.bot.on('message:voice', async (ctx) => {
      const voice: { file_id: string; mime_type?: string } | undefined =
        ctx.message.voice;
      if (voice?.file_id) {
        await storeWithDownload(
          ctx,
          voice.file_id,
          '[Voice message]',
          voice.mime_type,
        );
      } else {
        storeNonText(ctx, '[Voice message]');
      }
    });

    this.bot.on('message:audio', async (ctx) => {
      const audio: { file_id: string; mime_type?: string } | undefined =
        ctx.message.audio;
      if (audio?.file_id) {
        await storeWithDownload(ctx, audio.file_id, '[Audio]', audio.mime_type);
      } else {
        storeNonText(ctx, '[Audio]');
      }
    });

    this.bot.on('message:document', async (ctx) => {
      const doc: {
        file_id: string;
        file_name?: string;
        mime_type?: string;
      } | undefined = ctx.message.document;
      const name = doc?.file_name || 'file';
      if (doc?.file_id) {
        await storeWithDownload(
          ctx,
          doc.file_id,
          `[Document: ${name}]`,
          doc.mime_type,
        );
      } else {
        storeNonText(ctx, `[Document: ${name}]`);
      }
    });

    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});

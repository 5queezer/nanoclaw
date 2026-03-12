import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

const execFileAsync = promisify(execFile);

export interface GmailChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface EnvelopeEntry {
  id: string;
  flags: string;
  subject: string;
  from: string;
  date: string;
}

export class GmailChannel implements Channel {
  name = 'gmail';

  private opts: GmailChannelOpts;
  private pollIntervalMs: number;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private processedIds = new Set<string>();
  private consecutiveErrors = 0;
  private connected = false;

  constructor(opts: GmailChannelOpts, pollIntervalMs = 60000) {
    this.opts = opts;
    this.pollIntervalMs = pollIntervalMs;
  }

  async connect(): Promise<void> {
    const configPath = path.join(
      os.homedir(),
      '.config',
      'himalaya',
      'config.toml',
    );
    if (!fs.existsSync(configPath)) {
      logger.warn(
        'Himalaya config not found at ~/.config/himalaya/config.toml. Skipping Gmail channel.',
      );
      return;
    }

    // Verify connection by listing 1 envelope
    try {
      await execFileAsync('himalaya', [
        'envelope',
        'list',
        '-a',
        'gmail',
        '-s',
        '1',
        '-o',
        'json',
      ]);
    } catch (err) {
      logger.error({ err }, 'Failed to connect to Gmail via Himalaya');
      return;
    }

    this.connected = true;
    logger.info('Gmail channel connected via Himalaya');

    // Start polling
    const schedulePoll = () => {
      const backoffMs =
        this.consecutiveErrors > 0
          ? Math.min(
              this.pollIntervalMs * Math.pow(2, this.consecutiveErrors),
              30 * 60 * 1000,
            )
          : this.pollIntervalMs;
      this.pollTimer = setTimeout(() => {
        this.pollForMessages()
          .catch((err) => logger.error({ err }, 'Gmail poll error'))
          .finally(() => {
            if (this.connected) schedulePoll();
          });
      }, backoffMs);
    };

    await this.pollForMessages();
    schedulePoll();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected) {
      logger.warn('Gmail not initialized');
      return;
    }

    // jid format: gmail:<id>:<from-email>:<subject>
    const parts = jid.replace(/^gmail:/, '').split(':');
    const toEmail = parts[1] || '';
    const subject = parts.slice(2).join(':') || '(no subject)';

    if (!toEmail) {
      logger.warn({ jid }, 'No recipient email in JID, cannot send');
      return;
    }

    // Sanitise to prevent header injection: strip CR/LF from header values
    const sanitize = (v: string) => v.replace(/[\r\n]+/g, ' ').trim();
    const safeEmail = sanitize(toEmail);
    const safeSubject = sanitize(
      subject.startsWith('Re:') ? subject : `Re: ${subject}`,
    );

    // Build RFC 2822 message
    const message = [
      `To: ${safeEmail}`,
      `Subject: ${safeSubject}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      text,
    ].join('\r\n');

    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn('himalaya', ['message', 'send', '-a', 'gmail']);
        proc.stdin.write(message);
        proc.stdin.end();
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`himalaya send exited with code ${code}`));
        });
        proc.on('error', reject);
      });
      logger.info({ to: toEmail }, 'Gmail reply sent via Himalaya');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Gmail reply');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('gmail:');
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.connected = false;
    logger.info('Gmail channel stopped');
  }

  // --- Private ---

  private async pollForMessages(): Promise<void> {
    if (!this.connected) return;

    try {
      // List unread envelopes from INBOX
      const { stdout } = await execFileAsync('himalaya', [
        'envelope',
        'list',
        '-a',
        'gmail',
        '-f',
        'INBOX',
        '-s',
        '10',
        '-o',
        'json',
      ]);

      const envelopes: EnvelopeEntry[] = JSON.parse(stdout);

      for (const env of envelopes) {
        // Skip already-processed and read messages
        if (this.processedIds.has(env.id)) continue;
        if (!env.flags.includes('*')) {
          // no unread flag
          this.processedIds.add(env.id);
          continue;
        }

        this.processedIds.add(env.id);
        await this.processMessage(env);
      }

      // Cap processed ID set
      if (this.processedIds.size > 5000) {
        const ids = [...this.processedIds];
        this.processedIds = new Set(ids.slice(ids.length - 2500));
      }

      this.consecutiveErrors = 0;
    } catch (err) {
      this.consecutiveErrors++;
      logger.error(
        { err, consecutiveErrors: this.consecutiveErrors },
        'Gmail poll failed',
      );
    }
  }

  private async processMessage(env: EnvelopeEntry): Promise<void> {
    try {
      // Read the message body as plain text
      const { stdout: body } = await execFileAsync('himalaya', [
        'message',
        'read',
        '-a',
        'gmail',
        '-f',
        'INBOX',
        '-t',
        'plain',
        env.id,
      ]);

      if (!body.trim()) {
        logger.debug(
          { id: env.id, subject: env.subject },
          'Skipping email with no text body',
        );
        return;
      }

      // Parse sender: "Name <email>" or just "email"
      const senderMatch = env.from.match(/^(.+?)\s*<(.+?)>$/);
      const senderName = senderMatch
        ? senderMatch[1].replace(/"/g, '')
        : env.from;
      const senderEmail = senderMatch ? senderMatch[2] : env.from;

      // JID encodes id, sender email, and subject for replies
      const chatJid = `gmail:${env.id}:${senderEmail}:${env.subject}`;
      const timestamp = new Date(env.date).toISOString();

      // Store chat metadata
      this.opts.onChatMetadata(chatJid, timestamp, env.subject, 'gmail', false);

      // Deliver to main group
      const groups = this.opts.registeredGroups();
      const mainEntry = Object.entries(groups).find(
        ([, g]) => g.isMain === true,
      );

      if (!mainEntry) {
        logger.debug(
          { chatJid, subject: env.subject },
          'No main group registered, skipping email',
        );
        return;
      }

      const mainJid = mainEntry[0];
      const content = `[Email from ${senderName} <${senderEmail}>]\nSubject: ${env.subject}\n\n${body}`;

      this.opts.onMessage(mainJid, {
        id: env.id,
        chat_jid: mainJid,
        sender: senderEmail,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      // Mark as read using himalaya flag command
      try {
        await execFileAsync('himalaya', [
          'flag',
          'remove',
          '-a',
          'gmail',
          '-f',
          'INBOX',
          env.id,
          '--',
          'Seen',
        ]);
      } catch (flagErr) {
        // Try alternative: add seen flag
        try {
          await execFileAsync('himalaya', [
            'flag',
            'add',
            '-a',
            'gmail',
            '-f',
            'INBOX',
            env.id,
            '--',
            'Seen',
          ]);
        } catch (err) {
          logger.warn({ id: env.id, err }, 'Failed to mark email as read');
        }
      }

      logger.info(
        { mainJid, from: senderName, subject: env.subject },
        'Gmail email delivered to main group',
      );
    } catch (err) {
      logger.error({ id: env.id, err }, 'Failed to process email');
    }
  }
}

registerChannel('gmail', (opts: ChannelOpts) => {
  const configPath = path.join(
    os.homedir(),
    '.config',
    'himalaya',
    'config.toml',
  );
  if (!fs.existsSync(configPath)) {
    logger.warn('Gmail: Himalaya config not found at ~/.config/himalaya/');
    return null;
  }
  return new GmailChannel(opts);
});

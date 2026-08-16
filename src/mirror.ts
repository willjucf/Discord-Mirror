import { logger } from './log.js';
import { buildMessage, type BuildContext } from './build.js';
import { MessageStore } from './store.js';
import { WebhookClient } from './webhook.js';
import { CONTENT_MESSAGE_TYPES, THREAD_CHANNEL_TYPES, type Message } from './types.js';
import type { AppConfig, MirrorDef } from './config.js';
import type { DiscordCache } from './cache.js';
import type { Rest } from './rest.js';

const log = logger('mirror');

interface CompiledFilters {
  include?: RegExp;
  exclude?: RegExp;
}

export class MirrorService {
  private webhooks = new Map<string, WebhookClient>();
  private filters = new Map<string, CompiledFilters>();
  private store = new MessageStore();
  private messageCache = new Map<string, Message>();
  private selfId?: string;
  private ctx: BuildContext;

  constructor(
    private readonly config: AppConfig,
    private readonly cache: DiscordCache,
    private readonly rest: Rest,
  ) {
    for (const mirror of config.mirrors) {
      if (!mirror.enabled) continue;
      this.webhooks.set(mirror.name, new WebhookClient(mirror.webhookUrl, mirror.name));
      this.filters.set(mirror.name, {
        include: mirror.filters.includeRegex ? new RegExp(mirror.filters.includeRegex, 'i') : undefined,
        exclude: mirror.filters.excludeRegex ? new RegExp(mirror.filters.excludeRegex, 'i') : undefined,
      });
    }

    this.ctx = {
      cache: this.cache,
      targetChannelFor: (sourceChannelId) =>
        this.config.byChannel.get(sourceChannelId)?.find((m) => m.targetChannelId)?.targetChannelId,
      fetchMessage: (channelId, messageId) => this.fetchMessage(channelId, messageId),
      mirroredJump: (sourceMessageId, mirror) => {
        if (!mirror.targetGuildId || !mirror.targetChannelId) return undefined;
        const target = this.store.get(sourceMessageId)?.targets.find((t) => t.mirror === mirror.name);
        const messageId = target?.messageIds[0];
        if (!messageId) return undefined;
        return `https://discord.com/channels/${mirror.targetGuildId}/${mirror.targetChannelId}/${messageId}`;
      },
    };
  }

  setSelf(userId: string): void {
    this.selfId = userId;
  }

  /** Confirms every webhook is alive and reports where it points. */
  async verifyWebhooks(): Promise<void> {
    for (const mirror of this.config.mirrors) {
      if (!mirror.enabled) {
        log.info(`mirror "${mirror.name}" is disabled in config`);
        continue;
      }
      const webhook = this.webhooks.get(mirror.name)!;
      const info = await webhook.verify();
      if (info) {
        // The webhook knows where it posts, so reply jump links and <#channel>
        // rewrites work without having to configure the destination by hand.
        mirror.targetChannelId ??= info.channel_id;
        mirror.targetGuildId ??= info.guild_id;
        log.info(
          `mirror "${mirror.name}": ${mirror.sources.length} source channel(s) -> webhook "${info.name}" in channel ${info.channel_id}`,
        );
      } else {
        log.error(`mirror "${mirror.name}": webhook could not be verified and will be skipped`);
      }
    }
  }

  private async fetchMessage(channelId: string, messageId: string): Promise<Message | null> {
    const cached = this.messageCache.get(messageId);
    if (cached) return cached;
    try {
      const message = await this.rest.message(channelId, messageId);
      if (message) this.remember(message);
      return message;
    } catch (err) {
      log.debug(`could not fetch referenced message ${messageId}:`, (err as Error).message);
      return null;
    }
  }

  private remember(message: Message): void {
    this.messageCache.set(message.id, message);
    if (this.messageCache.size > 2000) {
      const oldest = this.messageCache.keys().next();
      if (!oldest.done) this.messageCache.delete(oldest.value);
    }
  }

  /**
   * Which mirrors want this channel? Messages posted in a thread are routed to
   * whatever mirrors watch the thread's parent channel.
   */
  private async mirrorsFor(channelId: string): Promise<MirrorDef[]> {
    const direct = this.config.byChannel.get(channelId);
    if (direct?.length) return direct;

    const channel = await this.cache.getChannel(channelId);
    if (!channel || !THREAD_CHANNEL_TYPES.has(channel.type) || !channel.parent_id) return [];

    const parents = this.config.byChannel.get(channel.parent_id) ?? [];
    return parents.filter((mirror) => mirror.threads === 'inline');
  }

  private shouldMirror(msg: Message, mirror: MirrorDef): boolean {
    const f = mirror.filters;

    if (!mirror.systemMessages && !CONTENT_MESSAGE_TYPES.has(msg.type)) return false;
    if (f.ignoreSelf && this.selfId && msg.author?.id === this.selfId) return false;
    if (f.ignoreWebhooks && msg.webhook_id) return false;
    if (f.ignoreBots && msg.author?.bot) return false;
    if (f.ignoreUserIds.includes(msg.author?.id)) return false;
    if (f.onlyUserIds.length > 0 && !f.onlyUserIds.includes(msg.author?.id)) return false;

    if (f.ignoreEmpty) {
      const hasSomething =
        Boolean(msg.content?.trim()) ||
        Boolean(msg.attachments?.length) ||
        Boolean(msg.embeds?.length) ||
        Boolean(msg.sticker_items?.length) ||
        Boolean(msg.poll) ||
        Boolean(msg.message_snapshots?.length) ||
        Boolean(msg.components?.length);
      if (!hasSomething) return false;
    }

    const compiled = this.filters.get(mirror.name);
    const text = msg.content ?? '';
    if (compiled?.include && !compiled.include.test(text)) return false;
    if (compiled?.exclude && compiled.exclude.test(text)) return false;

    return true;
  }

  async handleCreate(msg: Message): Promise<void> {
    if (!msg?.channel_id || !msg.author) return;
    const mirrors = await this.mirrorsFor(msg.channel_id);
    if (mirrors.length === 0) return;

    this.remember(msg);

    for (const mirror of mirrors) {
      if (!this.shouldMirror(msg, mirror)) continue;
      const webhook = this.webhooks.get(mirror.name);
      if (!webhook || webhook.disabled) continue;

      try {
        const built = await buildMessage(msg, mirror, this.ctx);
        if (!built) continue;

        const sentIds: string[] = [];
        for (const payload of built.payloads) {
          const sent = await webhook.send(payload);
          if (sent) sentIds.push(sent.id);
        }

        if (sentIds.length) {
          this.store.add(msg.id, mirror.name, sentIds, built.signature);
          log.info(
            `[${mirror.name}] ${msg.author.username}: ${
              built.signature.slice(0, 80).replace(/\n/g, ' ') || '<media>'
            }`,
          );
        }
      } catch (err) {
        log.error(`[${mirror.name}] failed to mirror message ${msg.id}:`, err);
      }
    }
  }

  async handleUpdate(msg: Message): Promise<void> {
    // MESSAGE_UPDATE is often partial (e.g. a link unfurl finishing); those
    // carry no author and nothing worth re-sending.
    if (!msg?.id || !msg.author || msg.content === undefined) return;

    const entry = this.store.get(msg.id);
    if (!entry) return;

    const mirrors = await this.mirrorsFor(msg.channel_id);
    this.remember(msg);

    for (const target of entry.targets) {
      const mirror = mirrors.find((m) => m.name === target.mirror);
      if (!mirror?.mirrorEdits) continue;
      const webhook = this.webhooks.get(mirror.name);
      if (!webhook || webhook.disabled) continue;

      try {
        const built = await buildMessage(msg, mirror, this.ctx);
        if (!built || built.signature === entry.content) continue;

        // Only the first webhook message is edited in place; long messages that
        // spilled into follow-ups keep their original tail.
        const first = built.payloads[0];
        const messageId = target.messageIds[0];
        if (!first || !messageId) continue;

        await webhook.edit(messageId, {
          content: first.content ?? '',
          embeds: first.embeds ?? [],
          allowed_mentions: first.allowed_mentions,
        });
        this.store.setContent(msg.id, built.signature);
        log.debug(`[${mirror.name}] edited mirrored message ${messageId}`);
      } catch (err) {
        log.debug(`[${mirror.name}] edit failed for ${msg.id}:`, (err as Error).message);
      }
    }
  }

  async handleDelete(messageId: string, channelId: string): Promise<void> {
    const entry = this.store.delete(messageId);
    if (!entry) return;

    const mirrors = await this.mirrorsFor(channelId);
    for (const target of entry.targets) {
      const mirror = mirrors.find((m) => m.name === target.mirror);
      if (!mirror?.mirrorDeletes) continue;
      const webhook = this.webhooks.get(mirror.name);
      if (!webhook || webhook.disabled) continue;

      for (const id of target.messageIds) await webhook.remove(id);
      log.debug(`[${mirror.name}] deleted ${target.messageIds.length} mirrored message(s)`);
    }
  }

  async handleBulkDelete(ids: string[], channelId: string): Promise<void> {
    for (const id of ids) await this.handleDelete(id, channelId);
  }
}

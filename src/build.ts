import { logger } from './log.js';
import type { MirrorDef } from './config.js';
import type { DiscordCache } from './cache.js';
import type { OutgoingFile, WebhookPayload } from './webhook.js';
import { MessageFlags, THREAD_CHANNEL_TYPES, type Attachment, type Embed, type Message, type User } from './types.js';

const log = logger('build');

const CONTENT_LIMIT = 2000;
const EMBED_LIMIT = 10;
const EMBED_DESCRIPTION_LIMIT = 4096;
const USERNAME_LIMIT = 80;

/** `<@&id>` | `<@id>` / `<@!id>` | `<#id>` | `@everyone` | `@here` */
const MENTION_RE = /<@&(\d+)>|<@!?(\d+)>|<#(\d+)>|@everyone|@here/g;

/** Embeds Discord generates itself from links in the content. */
const AUTO_EMBED_TYPES = new Set(['image', 'video', 'gifv', 'article', 'link']);

/** Zero-width space — breaks `@everyone` parsing without changing how it looks. */
const ZWSP = '​';

export interface MentionGrants {
  roles: Set<string>;
  users: Set<string>;
  everyone: boolean;
}

export interface BuildContext {
  cache: DiscordCache;
  /** Resolves a source channel id to the mirrored channel id, when known. */
  targetChannelFor(sourceChannelId: string): string | undefined;
  /** Fetches a message the gateway did not inline (used for replies). */
  fetchMessage(channelId: string, messageId: string): Promise<Message | null>;
  /** Jump link to this mirror's own copy of a source message, if we posted one. */
  mirroredJump(sourceMessageId: string, mirror: MirrorDef): string | undefined;
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function displayName(user: User, member?: { nick?: string | null }, style: MirrorDef['nameStyle'] = 'nickname'): string {
  const nick = member?.nick?.trim();
  const global = user.global_name?.trim();
  if (style === 'username') return user.username;
  if (style === 'display') return global || user.username;
  return nick || global || user.username;
}

/**
 * Discord rejects webhook usernames containing "discord" or "clyde", and caps
 * them at 80 characters. Break the reserved words with a zero-width space so
 * the name still reads correctly.
 */
function sanitizeUsername(name: string): string {
  let out = name.replace(/\s+/g, ' ').trim();
  out = out.replace(/discord/gi, (m) => `${m[0]}${ZWSP}${m.slice(1)}`);
  out = out.replace(/clyde/gi, (m) => `${m[0]}${ZWSP}${m.slice(1)}`);
  out = truncate(out, USERNAME_LIMIT);
  return out || 'Unknown User';
}

function avatarUrl(msg: Message): string {
  const user = msg.author;
  if (msg.guild_id && msg.member?.avatar) {
    const ext = msg.member.avatar.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/guilds/${msg.guild_id}/users/${user.id}/avatars/${msg.member.avatar}.${ext}?size=128`;
  }
  if (user.avatar) {
    const ext = user.avatar.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=128`;
  }
  const legacy = user.discriminator && user.discriminator !== '0' ? Number(user.discriminator) % 5 : null;
  const index = legacy ?? Number((BigInt(user.id) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

/** Splits on paragraph, then line, then word boundaries. */
export function splitContent(text: string, limit = CONTENT_LIMIT): string[] {
  if (text.length <= limit) return text ? [text] : [];
  const chunks: string[] = [];
  let rest = text;

  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit);
    if (cut < limit * 0.4) cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.4) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit * 0.4) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

// ---------------------------------------------------------------------------
// mention translation
// ---------------------------------------------------------------------------

/**
 * Rewrites every mention in `text` for the destination server.
 *
 * Roles and @everyone/@here are swapped for their configured counterparts and
 * recorded in `grants` so `allowed_mentions` can whitelist exactly those (and
 * nothing else). Anything unmapped is downgraded to inert plain text, so a
 * mirror can never ping something the operator did not ask for.
 *
 * `textOnly` is used for quoted/forwarded excerpts, which must never ping.
 */
export async function transformMentions(
  text: string,
  msg: Message,
  mirror: MirrorDef,
  ctx: BuildContext,
  grants: MentionGrants,
  textOnly = false,
): Promise<string> {
  if (!text) return '';

  const matches = [...text.matchAll(MENTION_RE)];
  if (matches.length === 0) return text;

  const { mentions } = mirror;
  const replacements = await Promise.all(
    matches.map(async (match): Promise<string> => {
      const [raw, roleId, userId, channelId] = match;

      // --- role mentions -------------------------------------------------
      if (roleId) {
        // "*" is a catch-all: any role without its own entry maps to it.
        const mapped = mentions.roles[roleId] ?? mentions.roles['*'];
        if (mapped && !textOnly) {
          for (const id of mapped.matchAll(/<@&(\d+)>/g)) grants.roles.add(id[1]);
          if (/@everyone|@here/.test(mapped)) grants.everyone = true;
          return mapped;
        }
        if (mentions.unmappedRoles === 'strip') return '';
        if (mentions.unmappedRoles === 'keep' && !textOnly) return raw;
        const name = await ctx.cache.getRoleName(msg.guild_id, roleId);
        return `@${name ?? 'unknown-role'}`;
      }

      // --- user mentions -------------------------------------------------
      if (userId) {
        const mapped = mentions.users[userId];
        if (mapped && !textOnly) {
          for (const id of mapped.matchAll(/<@!?(\d+)>/g)) grants.users.add(id[1]);
          return mapped;
        }
        if (mentions.unmappedUsers === 'strip') return '';
        if (mentions.unmappedUsers === 'keep' && !textOnly) return raw;
        const mentioned = msg.mentions?.find((u) => u.id === userId);
        const name = mentioned ? displayName(mentioned, mentioned.member, mirror.nameStyle) : undefined;
        return `@${name ?? 'unknown-user'}`;
      }

      // --- channel mentions ----------------------------------------------
      if (channelId) {
        const target = ctx.targetChannelFor(channelId);
        if (target && !textOnly) return `<#${target}>`;
        const channel = await ctx.cache.getChannel(channelId);
        return `#${channel?.name ?? 'unknown-channel'}`;
      }

      // --- @everyone / @here ---------------------------------------------
      const isEveryone = raw === '@everyone';
      const configured = isEveryone ? mentions.everyone : mentions.here;

      // Only honour it if the source message genuinely pinged; otherwise the
      // author just typed the words and we must not turn that into a ping.
      if (configured && !textOnly && msg.mention_everyone) {
        for (const id of configured.matchAll(/<@&(\d+)>/g)) grants.roles.add(id[1]);
        if (/@everyone|@here/.test(configured)) grants.everyone = true;
        return configured;
      }
      return `@${ZWSP}${isEveryone ? 'everyone' : 'here'}`;
    }),
  );

  let out = '';
  let cursor = 0;
  matches.forEach((match, i) => {
    out += text.slice(cursor, match.index!) + replacements[i];
    cursor = match.index! + match[0].length;
  });
  return out + text.slice(cursor);
}

// ---------------------------------------------------------------------------
// attachments
// ---------------------------------------------------------------------------

async function download(url: string, maxBytes: number): Promise<Uint8Array | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared && declared > maxBytes) return null;
  const buffer = new Uint8Array(await res.arrayBuffer());
  return buffer.byteLength > maxBytes ? null : buffer;
}

interface MediaResult {
  files: OutgoingFile[];
  links: string[];
}

/**
 * Re-uploads attachments so they live in the mirror server permanently — the
 * source CDN links are signed and expire. Anything too large falls back to a
 * link, which Discord still unfurls for images/videos/gifs.
 */
async function collectAttachments(attachments: Attachment[], mirror: MirrorDef): Promise<MediaResult> {
  const result: MediaResult = { files: [], links: [] };
  const cfg = mirror.attachments;
  if (cfg.mode === 'off' || attachments.length === 0) return result;

  let budget = cfg.maxTotalBytes;

  for (const attachment of attachments) {
    const wantLink = cfg.mode === 'link' || cfg.mode === 'both';
    const wantFile = cfg.mode === 'reupload' || cfg.mode === 'both';

    if (wantFile && result.files.length < cfg.maxFiles && attachment.size <= Math.min(cfg.maxFileBytes, budget)) {
      try {
        const data = await download(attachment.url, Math.min(cfg.maxFileBytes, budget));
        if (data) {
          budget -= data.byteLength;
          result.files.push({
            name: attachment.filename,
            data,
            contentType: attachment.content_type,
            description: attachment.description,
          });
          if (wantLink) result.links.push(attachment.url);
          continue;
        }
      } catch (err) {
        log.debug(`attachment download failed (${attachment.filename}):`, (err as Error).message);
      }
    }

    // Too big, too many, or the download failed — hand over the CDN link.
    result.links.push(attachment.url);
  }

  return result;
}

// ---------------------------------------------------------------------------
// embeds
// ---------------------------------------------------------------------------

function sanitizeEmbed(embed: Embed): Embed {
  const out: Embed = {};
  if (embed.title) out.title = truncate(embed.title, 256);
  if (embed.description) out.description = truncate(embed.description, EMBED_DESCRIPTION_LIMIT);
  if (embed.url) out.url = embed.url;
  if (embed.timestamp) out.timestamp = embed.timestamp;
  if (typeof embed.color === 'number') out.color = embed.color;
  if (embed.footer?.text) out.footer = { text: truncate(embed.footer.text, 2048), icon_url: embed.footer.icon_url };
  if (embed.image?.url) out.image = { url: embed.image.url };
  if (embed.thumbnail?.url) out.thumbnail = { url: embed.thumbnail.url };
  if (embed.author?.name) {
    out.author = { name: truncate(embed.author.name, 256), url: embed.author.url, icon_url: embed.author.icon_url };
  }
  if (embed.fields?.length) {
    out.fields = embed.fields.slice(0, 25).map((f) => ({
      name: truncate(f.name, 256),
      value: truncate(f.value, 1024),
      inline: f.inline,
    }));
  }
  return out;
}

function passthroughEmbeds(msg: Message, mirror: MirrorDef): Embed[] {
  if (mirror.embeds === 'none') return [];
  if ((msg.flags ?? 0) & MessageFlags.SUPPRESS_EMBEDS) return [];
  const source = msg.embeds ?? [];

  return source
    .filter((embed) => {
      if (mirror.embeds === 'all') return true;
      // "rich" — drop the ones Discord will regenerate from the links we forward.
      if (embed.type && AUTO_EMBED_TYPES.has(embed.type)) return false;
      if (embed.url && msg.content?.includes(embed.url)) return false;
      return true;
    })
    .map(sanitizeEmbed);
}

function stickerParts(msg: Message, mirror: MirrorDef): { embeds: Embed[]; notes: string[] } {
  const embeds: Embed[] = [];
  const notes: string[] = [];
  if (!mirror.stickers) return { embeds, notes };

  for (const sticker of msg.sticker_items ?? []) {
    if (sticker.format_type === 3) {
      // Lottie stickers are vector animations with no static URL we can embed.
      notes.push(`*[sticker: ${sticker.name}]*`);
      continue;
    }
    const ext = sticker.format_type === 4 ? 'gif' : 'png';
    embeds.push({
      color: mirror.accentColor,
      footer: { text: `Sticker · ${sticker.name}` },
      image: { url: `https://media.discordapp.net/stickers/${sticker.id}.${ext}?size=240` },
    });
  }
  return { embeds, notes };
}

function pollEmbed(msg: Message, mirror: MirrorDef): Embed | null {
  if (!mirror.polls || !msg.poll) return null;
  const counts = new Map<number, number>();
  for (const entry of msg.poll.results?.answer_counts ?? []) counts.set(entry.id, entry.count);

  const lines = msg.poll.answers.map((answer) => {
    const emoji = answer.poll_media.emoji;
    const prefix = emoji?.id ? `<:${emoji.name ?? '_'}:${emoji.id}>` : (emoji?.name ?? '•');
    const votes = counts.get(answer.answer_id);
    return `${prefix} ${answer.poll_media.text ?? ''}${votes ? ` — **${votes}**` : ''}`;
  });

  return {
    color: mirror.accentColor,
    title: truncate(msg.poll.question.text ?? 'Poll', 256),
    description: truncate(lines.join('\n'), EMBED_DESCRIPTION_LIMIT),
    footer: { text: msg.poll.allow_multiselect ? 'Poll · multiple choice' : 'Poll' },
  };
}

// ---------------------------------------------------------------------------
// components v2
// ---------------------------------------------------------------------------

/**
 * Components-v2 messages put their text inside the component tree and leave
 * `content` empty. Incoming webhooks cannot send components, so flatten the
 * tree into markdown plus a list of media links.
 */
function flattenComponents(components: any[] | undefined, out = { text: [] as string[], media: [] as string[] }) {
  for (const component of components ?? []) {
    switch (component?.type) {
      case 10: // TextDisplay
        if (component.content) out.text.push(String(component.content));
        break;
      case 9: // Section
        flattenComponents(component.components, out);
        if (component.accessory?.media?.url) out.media.push(component.accessory.media.url);
        break;
      case 17: // Container
      case 18: // Label
        flattenComponents(component.components ?? [component.component], out);
        break;
      case 12: // MediaGallery
        for (const item of component.items ?? []) if (item?.media?.url) out.media.push(item.media.url);
        break;
      case 13: // File
        if (component.file?.url) out.media.push(component.file.url);
        break;
      case 14: // Separator
        out.text.push('---');
        break;
      case 1: {
        // ActionRow — keep link buttons, they carry real information.
        const links = (component.components ?? [])
          .filter((c: any) => c?.type === 2 && c.url)
          .map((c: any) => `[${c.label ?? 'link'}](${c.url})`);
        if (links.length) out.text.push(links.join(' · '));
        break;
      }
      default:
        if (Array.isArray(component?.components)) flattenComponents(component.components, out);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// replies & forwards
// ---------------------------------------------------------------------------

async function replyPreview(
  msg: Message,
  mirror: MirrorDef,
  ctx: BuildContext,
): Promise<{ embed?: Embed; quote?: string } | null> {
  if (!mirror.replies.enabled) return null;
  const ref = msg.message_reference;
  // type 1 is a forward, handled separately.
  if (!ref?.message_id || (ref.type ?? 0) !== 0) return null;

  let referenced = msg.referenced_message ?? null;
  if (!referenced && mirror.replies.fetchMissing) {
    referenced = await ctx.fetchMessage(ref.channel_id ?? msg.channel_id, ref.message_id);
  }

  // Prefer linking to our own mirrored copy so the jump lands in this server.
  // Falls back to the source message when we never mirrored it (posted before
  // startup, filtered out, or aged out of the store).
  const mirrored = ctx.mirroredJump(ref.message_id, mirror);
  const jump =
    mirrored ??
    `https://discord.com/channels/${ref.guild_id ?? msg.guild_id ?? '@me'}/${
      ref.channel_id ?? msg.channel_id
    }/${ref.message_id}`;
  const jumpLabel = mirrored ? 'Jump to message' : 'Jump to original';

  if (!referenced) {
    const text = '*original message unavailable*';
    return mirror.replies.style === 'quote'
      ? { quote: `> ↪ [reply](${jump}) to ${text}` }
      : { embed: { color: mirror.accentColor, description: `↪ [Replying to a message](${jump}) — ${text}` } };
  }

  const author = displayName(referenced.author, referenced.member, mirror.nameStyle);
  const throwaway: MentionGrants = { roles: new Set(), users: new Set(), everyone: false };
  let excerpt = await transformMentions(referenced.content ?? '', referenced, mirror, ctx, throwaway, true);
  excerpt = excerpt.replace(/\s*\n\s*/g, ' ').trim();

  if (!excerpt) {
    const kinds: string[] = [];
    if (referenced.attachments?.length) kinds.push(`${referenced.attachments.length} attachment(s)`);
    if (referenced.sticker_items?.length) kinds.push('sticker');
    if (referenced.embeds?.length) kinds.push('embed');
    excerpt = kinds.length ? `*${kinds.join(', ')}*` : '*no content*';
  }
  excerpt = truncate(excerpt, mirror.replies.maxLength);

  if (mirror.replies.style === 'quote') {
    return { quote: `> **↪ ${author}** [·](${jump}) ${excerpt}` };
  }

  return {
    embed: {
      color: mirror.accentColor,
      author: { name: `↪ replying to ${truncate(author, 200)}`, icon_url: avatarUrl(referenced) },
      description: `${excerpt}\n\n[${jumpLabel}](${jump})`,
    },
  };
}

async function forwardParts(
  msg: Message,
  mirror: MirrorDef,
  ctx: BuildContext,
): Promise<{ embeds: Embed[]; links: string[] }> {
  const embeds: Embed[] = [];
  const links: string[] = [];
  if (!mirror.forwards || !msg.message_snapshots?.length) return { embeds, links };

  const throwaway: MentionGrants = { roles: new Set(), users: new Set(), everyone: false };

  for (const snapshot of msg.message_snapshots) {
    const inner = snapshot.message ?? {};
    const body = await transformMentions(
      inner.content ?? '',
      { ...(inner as Message), guild_id: msg.message_reference?.guild_id },
      mirror,
      ctx,
      throwaway,
      true,
    );

    const attachmentLinks = (inner.attachments ?? []).map((a) => a.url);
    links.push(...attachmentLinks);

    const description = [body, attachmentLinks.length ? `*${attachmentLinks.length} attachment(s)*` : '']
      .filter(Boolean)
      .join('\n\n');

    embeds.push({
      color: mirror.accentColor,
      author: { name: '⤷ Forwarded message' },
      description: truncate(description || '*no content*', EMBED_DESCRIPTION_LIMIT),
      timestamp: inner.timestamp,
    });

    if (inner.embeds?.length) embeds.push(...inner.embeds.slice(0, 3).map(sanitizeEmbed));
  }

  return { embeds, links };
}

// ---------------------------------------------------------------------------
// assembly
// ---------------------------------------------------------------------------

export interface BuiltMessage {
  /** One or more webhook payloads, to be sent in order. */
  payloads: WebhookPayload[];
  /** Canonical content used for edit-change detection. */
  signature: string;
}

/** Builds the small grey subtext header (`-# #channel · 🧵 thread`). */
async function contextLine(msg: Message, mirror: MirrorDef, ctx: BuildContext): Promise<string> {
  const parts: string[] = [];
  const channel = await ctx.cache.getChannel(msg.channel_id);
  const isThread = channel ? THREAD_CHANNEL_TYPES.has(channel.type) : false;

  if (isThread && mirror.threads === 'inline') {
    const parent = channel?.parent_id ? await ctx.cache.getChannel(channel.parent_id) : undefined;
    if (mirror.showSourceChannel && parent?.name) parts.push(`#${parent.name}`);
    parts.push(`🧵 ${channel?.name ?? 'thread'}`);
  } else if (mirror.showSourceChannel && channel?.name) {
    parts.push(`#${channel.name}`);
  }

  return parts.length ? `-# ${parts.join(' · ')}` : '';
}

export async function buildMessage(msg: Message, mirror: MirrorDef, ctx: BuildContext): Promise<BuiltMessage | null> {
  const grants: MentionGrants = { roles: new Set(), users: new Set(), everyone: false };

  let body = await transformMentions(msg.content ?? '', msg, mirror, ctx, grants);

  // Components v2 keeps its text out of `content`.
  const componentText: string[] = [];
  const componentMedia: string[] = [];
  if (mirror.componentsV2 && (msg.flags ?? 0) & MessageFlags.IS_COMPONENTS_V2) {
    const flat = flattenComponents(msg.components);
    for (const chunk of flat.text) {
      componentText.push(await transformMentions(chunk, msg, mirror, ctx, grants));
    }
    componentMedia.push(...flat.media);
  }

  const reply = await replyPreview(msg, mirror, ctx);
  const forwards = await forwardParts(msg, mirror, ctx);
  const stickers = stickerParts(msg, mirror);
  const poll = pollEmbed(msg, mirror);
  const media = await collectAttachments(msg.attachments ?? [], mirror);
  const header = await contextLine(msg, mirror, ctx);

  const isVoice = ((msg.flags ?? 0) & MessageFlags.IS_VOICE_MESSAGE) !== 0;

  const segments = [
    header,
    reply?.quote ?? '',
    body,
    componentText.join('\n'),
    stickers.notes.join('\n'),
    isVoice ? '-# 🎤 voice message' : '',
    [...media.links, ...componentMedia, ...forwards.links].join('\n'),
  ].filter((segment) => segment.length > 0);

  const content = segments.join('\n');

  const embeds = [
    ...(reply?.embed ? [reply.embed] : []),
    ...forwards.embeds,
    ...(poll ? [poll] : []),
    ...stickers.embeds,
    ...passthroughEmbeds(msg, mirror),
  ].slice(0, EMBED_LIMIT);

  if (!content && embeds.length === 0 && media.files.length === 0) return null;

  const username = sanitizeUsername(
    `${mirror.usernamePrefix}${displayName(msg.author, msg.member, mirror.nameStyle)}${mirror.usernameSuffix}`,
  );
  const avatar = avatarUrl(msg);

  const parse: ('users' | 'roles' | 'everyone')[] = grants.everyone ? ['everyone'] : [];
  const allowed_mentions = {
    parse,
    roles: [...grants.roles],
    users: [...grants.users],
  };

  const chunks = splitContent(content);
  const payloads: WebhookPayload[] = [];

  if (chunks.length === 0) {
    payloads.push({ username, avatar_url: avatar, allowed_mentions, embeds, files: media.files });
  } else {
    chunks.forEach((chunk, index) => {
      const last = index === chunks.length - 1;
      payloads.push({
        username,
        avatar_url: avatar,
        content: chunk,
        allowed_mentions,
        // Embeds and files ride along with the final chunk so they appear last.
        ...(last ? { embeds, files: media.files } : {}),
      });
    });
  }

  return { payloads, signature: content };
}

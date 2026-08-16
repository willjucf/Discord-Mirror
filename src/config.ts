import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export type UnmappedStrategy = 'text' | 'keep' | 'strip';

export interface MentionConfig {
  /** What `@everyone` in the source becomes. e.g. "<@&123>" or "@everyone" or null to neutralise. */
  everyone: string | null;
  here: string | null;
  /** sourceRoleId -> replacement string ("<@&id>" is written for you if you give a bare id). */
  roles: Record<string, string>;
  /** sourceUserId -> replacement string. */
  users: Record<string, string>;
  unmappedRoles: UnmappedStrategy;
  unmappedUsers: UnmappedStrategy;
}

export interface AttachmentConfig {
  /** reupload = download & re-post (permanent), link = post the CDN url, both = do both, off = drop. */
  mode: 'reupload' | 'link' | 'both' | 'off';
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
}

export interface ReplyConfig {
  enabled: boolean;
  style: 'embed' | 'quote';
  maxLength: number;
  /** Fetch the referenced message over REST when the gateway did not inline it. */
  fetchMissing: boolean;
}

export interface FilterConfig {
  ignoreBots: boolean;
  ignoreWebhooks: boolean;
  ignoreSelf: boolean;
  ignoreUserIds: string[];
  onlyUserIds: string[];
  includeRegex: string | null;
  excludeRegex: string | null;
  /** Skip messages with no content, attachments, embeds, stickers or poll. */
  ignoreEmpty: boolean;
}

export interface MirrorOptions {
  /** nickname > display > username, falling back down the chain. */
  nameStyle: 'nickname' | 'display' | 'username';
  usernamePrefix: string;
  usernameSuffix: string;
  attachments: AttachmentConfig;
  replies: ReplyConfig;
  /** rich = only author-made embeds (skips auto link/image unfurls), all = everything, none = drop. */
  embeds: 'rich' | 'all' | 'none';
  stickers: boolean;
  polls: boolean;
  forwards: boolean;
  componentsV2: boolean;
  /** inline = messages from threads under a mapped channel are mirrored with a thread tag. */
  threads: 'inline' | 'off';
  systemMessages: boolean;
  mirrorEdits: boolean;
  mirrorDeletes: boolean;
  /** Prefix every mirrored message with the source channel name. */
  showSourceChannel: boolean;
  /** Accent colour (decimal) for reply/forward/poll embeds. */
  accentColor: number;
  mentions: MentionConfig;
  filters: FilterConfig;
}

export interface MirrorDef extends MirrorOptions {
  name: string;
  sources: string[];
  webhookUrl: string;
  /** Optional: lets `<#source>` mentions be rewritten to the mirrored channel. */
  targetChannelId?: string;
  targetGuildId?: string;
  enabled: boolean;
}

export interface AppConfig {
  token: string;
  gateway: {
    clientBuildNumber: number;
    capabilities: number;
    userAgent: string;
    browserVersion: string;
  };
  mirrors: MirrorDef[];
  /** channelId -> mirrors listening on it. */
  byChannel: Map<string, MirrorDef[]>;
}

const DEFAULT_OPTIONS: MirrorOptions = {
  nameStyle: 'nickname',
  usernamePrefix: '',
  usernameSuffix: '',
  attachments: {
    mode: 'reupload',
    maxFileBytes: 24 * 1024 * 1024,
    maxTotalBytes: 24 * 1024 * 1024,
    maxFiles: 10,
  },
  replies: { enabled: true, style: 'embed', maxLength: 200, fetchMissing: true },
  embeds: 'rich',
  stickers: true,
  polls: true,
  forwards: true,
  componentsV2: true,
  threads: 'inline',
  systemMessages: false,
  mirrorEdits: true,
  mirrorDeletes: true,
  showSourceChannel: false,
  accentColor: 0x5865f2,
  mentions: {
    everyone: null,
    here: null,
    roles: {},
    users: {},
    unmappedRoles: 'text',
    unmappedUsers: 'text',
  },
  filters: {
    ignoreBots: false,
    ignoreWebhooks: false,
    ignoreSelf: true,
    ignoreUserIds: [],
    onlyUserIds: [],
    includeRegex: null,
    excludeRegex: null,
    ignoreEmpty: true,
  },
};

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(override)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return out as T;
}

/**
 * Parses JSON with `//` and `/* *\/` comments and trailing commas, so the
 * config file can be annotated and hand-edited comfortably.
 *
 * Walks the text character by character tracking string context, otherwise a
 * `//` inside a URL like "https://..." would eat the rest of the line.
 */
function parseJsonc(raw: string): unknown {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    const next = raw[i + 1];

    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }

    if (char === '/' && next === '/') {
      while (i < raw.length && raw[i] !== '\n') i++;
      out += '\n';
      continue;
    }

    if (char === '/' && next === '*') {
      i += 2;
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i++;
      i++;
      continue;
    }

    out += char;
  }

  // Trailing commas before } or ]
  const cleaned = out.replace(/,(\s*[}\]])/g, '$1');

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Could not parse config file as JSON: ${(err as Error).message}`);
  }
}

function resolveSecret(value: string, field: string): string {
  if (value.startsWith('env:')) {
    const key = value.slice(4);
    const found = process.env[key];
    if (!found) throw new Error(`${field} points at env var "${key}" which is not set (check your .env)`);
    return found;
  }
  return value;
}

/** Accepts "<@&123>", "123" or free text; bare snowflakes become role pings. */
function normaliseMentionTarget(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const str = String(value).trim();
  if (/^\d{15,25}$/.test(str)) return `<@&${str}>`;
  return str;
}

function normaliseMentions(raw: unknown, base: MentionConfig): MentionConfig {
  const merged = deepMerge(base, raw);
  const roles: Record<string, string> = {};
  for (const [from, to] of Object.entries(merged.roles ?? {})) {
    const target = normaliseMentionTarget(to);
    if (target) roles[from] = target;
  }
  const users: Record<string, string> = {};
  for (const [from, to] of Object.entries(merged.users ?? {})) {
    const str = String(to).trim();
    users[from] = /^\d{15,25}$/.test(str) ? `<@${str}>` : str;
  }
  return {
    ...merged,
    everyone: normaliseMentionTarget(merged.everyone),
    here: normaliseMentionTarget(merged.here),
    roles,
    users,
  };
}

export function loadConfig(): AppConfig {
  const token = process.env.DISCORD_TOKEN?.trim();
  if (!token) {
    throw new Error('DISCORD_TOKEN is not set. Copy .env.example to .env and fill it in.');
  }

  const path = resolve(process.env.CONFIG_PATH ?? 'config.json');
  if (!existsSync(path)) {
    throw new Error(`Config file not found at ${path}. Copy config.example.json to config.json.`);
  }

  const raw = parseJsonc(readFileSync(path, 'utf8')) as Record<string, any>;
  const defaults = deepMerge(DEFAULT_OPTIONS, raw.defaults);
  defaults.mentions = normaliseMentions(raw.defaults?.mentions, DEFAULT_OPTIONS.mentions);

  if (!Array.isArray(raw.mirrors) || raw.mirrors.length === 0) {
    throw new Error('config.json must define at least one entry in "mirrors".');
  }

  const mirrors: MirrorDef[] = raw.mirrors.map((entry: Record<string, any>, index: number) => {
    const name = String(entry.name ?? `mirror-${index + 1}`);
    const sourcesRaw = entry.source ?? entry.sources;
    const sources = (Array.isArray(sourcesRaw) ? sourcesRaw : [sourcesRaw])
      .filter((v: unknown) => v !== undefined && v !== null)
      .map((v: unknown) => String(v).trim());

    if (sources.length === 0) {
      throw new Error(`Mirror "${name}" has no "source" channel id(s).`);
    }
    for (const id of sources) {
      if (!/^\d{15,25}$/.test(id)) {
        throw new Error(`Mirror "${name}" has an invalid channel id: ${id}`);
      }
    }
    if (!entry.webhook) throw new Error(`Mirror "${name}" is missing "webhook".`);

    const webhookUrl = resolveSecret(String(entry.webhook), `Mirror "${name}" webhook`);
    if (!/^https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+$/.test(webhookUrl)) {
      throw new Error(`Mirror "${name}" webhook URL looks malformed: ${webhookUrl}`);
    }

    const options = deepMerge(defaults, entry) as MirrorOptions;
    options.mentions = normaliseMentions(entry.mentions, defaults.mentions);

    return {
      ...options,
      name,
      sources,
      webhookUrl,
      targetChannelId: entry.targetChannelId ? String(entry.targetChannelId) : undefined,
      targetGuildId: entry.targetGuildId ? String(entry.targetGuildId) : undefined,
      enabled: entry.enabled !== false,
    };
  });

  const byChannel = new Map<string, MirrorDef[]>();
  for (const mirror of mirrors) {
    if (!mirror.enabled) continue;
    for (const channelId of mirror.sources) {
      const list = byChannel.get(channelId) ?? [];
      list.push(mirror);
      byChannel.set(channelId, list);
    }
  }

  return {
    token,
    gateway: {
      clientBuildNumber: Number(raw.gateway?.clientBuildNumber ?? 431500),
      capabilities: Number(raw.gateway?.capabilities ?? 161789),
      userAgent: String(raw.gateway?.userAgent ?? DEFAULT_UA),
      browserVersion: String(raw.gateway?.browserVersion ?? '136.0.0.0'),
    },
    mirrors,
    byChannel,
  };
}

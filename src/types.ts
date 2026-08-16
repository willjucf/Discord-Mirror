/** Minimal subset of the Discord v10 objects this program actually touches. */

export interface User {
  id: string;
  username: string;
  /** New username system: the pretty display name. Null for legacy accounts. */
  global_name?: string | null;
  discriminator?: string;
  avatar?: string | null;
  bot?: boolean;
  system?: boolean;
  public_flags?: number;
}

export interface Member {
  nick?: string | null;
  avatar?: string | null;
  roles?: string[];
}

export interface Attachment {
  id: string;
  filename: string;
  title?: string;
  description?: string;
  content_type?: string;
  size: number;
  url: string;
  proxy_url: string;
  width?: number;
  height?: number;
  /** Voice message metadata. */
  duration_secs?: number;
  waveform?: string;
  flags?: number;
}

export interface Embed {
  type?: string;
  title?: string;
  description?: string;
  url?: string;
  timestamp?: string;
  color?: number;
  footer?: { text: string; icon_url?: string };
  image?: { url: string };
  thumbnail?: { url: string };
  video?: { url?: string };
  provider?: { name?: string; url?: string };
  author?: { name: string; url?: string; icon_url?: string };
  fields?: { name: string; value: string; inline?: boolean }[];
}

export interface StickerItem {
  id: string;
  name: string;
  /** 1 PNG, 2 APNG, 3 LOTTIE, 4 GIF */
  format_type: number;
}

export interface MessageReference {
  /** 0 = DEFAULT (reply), 1 = FORWARD */
  type?: number;
  message_id?: string;
  channel_id?: string;
  guild_id?: string;
}

export interface Poll {
  question: { text?: string };
  answers: { answer_id: number; poll_media: { text?: string; emoji?: { id?: string; name?: string } } }[];
  expiry?: string | null;
  allow_multiselect?: boolean;
  results?: { answer_counts?: { id: number; count: number }[] };
}

export interface Message {
  id: string;
  type: number;
  channel_id: string;
  guild_id?: string;
  author: User;
  member?: Member;
  content: string;
  timestamp: string;
  edited_timestamp?: string | null;
  tts?: boolean;
  mention_everyone?: boolean;
  mentions?: (User & { member?: Member })[];
  mention_roles?: string[];
  attachments?: Attachment[];
  embeds?: Embed[];
  sticker_items?: StickerItem[];
  pinned?: boolean;
  webhook_id?: string;
  message_reference?: MessageReference;
  referenced_message?: Message | null;
  message_snapshots?: { message: Partial<Message> }[];
  components?: any[];
  flags?: number;
  poll?: Poll;
  interaction_metadata?: { user?: User; name?: string };
}

export interface Channel {
  id: string;
  type: number;
  guild_id?: string;
  name?: string;
  parent_id?: string | null;
}

export interface Role {
  id: string;
  name: string;
  color?: number;
}

/** Message flags we care about. */
export const MessageFlags = {
  CROSSPOSTED: 1 << 0,
  IS_CROSSPOST: 1 << 1,
  SUPPRESS_EMBEDS: 1 << 2,
  EPHEMERAL: 1 << 6,
  LOADING: 1 << 7,
  IS_VOICE_MESSAGE: 1 << 13,
  HAS_SNAPSHOT: 1 << 14,
  IS_COMPONENTS_V2: 1 << 15,
} as const;

/** Message types that carry real user content (everything else is a system notice). */
export const CONTENT_MESSAGE_TYPES = new Set([
  0, // DEFAULT
  19, // REPLY
  20, // CHAT_INPUT_COMMAND
  21, // THREAD_STARTER_MESSAGE
  23, // CONTEXT_MENU_COMMAND
]);

export const THREAD_CHANNEL_TYPES = new Set([10, 11, 12]);

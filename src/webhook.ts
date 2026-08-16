import { http, HttpError } from './http.js';
import { logger } from './log.js';
import type { Embed } from './types.js';

const log = logger('webhook');

export interface OutgoingFile {
  name: string;
  data: Uint8Array;
  contentType?: string;
  description?: string;
}

export interface WebhookPayload {
  username?: string;
  avatar_url?: string;
  content?: string;
  embeds?: Embed[];
  allowed_mentions?: {
    parse: ('users' | 'roles' | 'everyone')[];
    users?: string[];
    roles?: string[];
  };
  flags?: number;
  files?: OutgoingFile[];
}

export interface SentMessage {
  id: string;
  channel_id: string;
}

function buildBody(payload: WebhookPayload): { body: string | FormData; headers: Record<string, string> } {
  const { files, ...json } = payload;

  if (!files?.length) {
    return {
      body: JSON.stringify(json),
      headers: { 'Content-Type': 'application/json' },
    };
  }

  const form = new FormData();
  const attachments = files.map((file, index) => ({
    id: index,
    filename: file.name,
    ...(file.description ? { description: file.description } : {}),
  }));
  form.append('payload_json', JSON.stringify({ ...json, attachments }));
  files.forEach((file, index) => {
    const blob = new Blob([file.data], {
      type: file.contentType || 'application/octet-stream',
    });
    form.append(`files[${index}]`, blob, file.name);
  });

  // fetch sets the multipart boundary itself.
  return { body: form, headers: {} };
}

/**
 * A single incoming webhook. Every request for one webhook is funnelled through
 * the same rate-limit bucket key, so bursts queue instead of 429-storming.
 */
export class WebhookClient {
  readonly id: string;
  private readonly base: string;
  private readonly routeKey: string;
  private broken = false;

  constructor(
    readonly url: string,
    readonly label: string,
  ) {
    const match = url.match(/webhooks\/(\d+)\//);
    this.id = match?.[1] ?? 'unknown';
    this.base = url.replace(/\?.*$/, '');
    this.routeKey = `webhook:${this.id}`;
  }

  get disabled(): boolean {
    return this.broken;
  }

  private handleFatal(err: unknown): never | void {
    if (err instanceof HttpError && (err.status === 401 || err.status === 403 || err.status === 404)) {
      this.broken = true;
      log.error(
        `webhook for "${this.label}" is dead (HTTP ${err.status}) — this mirror is now disabled. ` +
          'Re-create the webhook and update your config.',
      );
      return;
    }
    throw err;
  }

  async send(payload: WebhookPayload, threadId?: string): Promise<SentMessage | null> {
    if (this.broken) return null;
    const query = new URLSearchParams({ wait: 'true' });
    if (threadId) query.set('thread_id', threadId);

    try {
      return await http.request<SentMessage>(this.routeKey, () => {
        const { body, headers } = buildBody(payload);
        return [`${this.base}?${query}`, { method: 'POST', headers, body }];
      });
    } catch (err) {
      this.handleFatal(err);
      log.warn(`send failed for "${this.label}":`, (err as Error).message);
      return null;
    }
  }

  async edit(messageId: string, payload: WebhookPayload): Promise<void> {
    if (this.broken) return;
    try {
      await http.request(
        this.routeKey,
        () => {
          const { body, headers } = buildBody(payload);
          return [`${this.base}/messages/${messageId}`, { method: 'PATCH', headers, body }];
        },
        { allow404: true },
      );
    } catch (err) {
      this.handleFatal(err);
      log.debug(`edit failed for "${this.label}":`, (err as Error).message);
    }
  }

  async remove(messageId: string): Promise<void> {
    if (this.broken) return;
    try {
      await http.request(
        this.routeKey,
        () => [`${this.base}/messages/${messageId}`, { method: 'DELETE' }],
        { allow404: true },
      );
    } catch (err) {
      this.handleFatal(err);
      log.debug(`delete failed for "${this.label}":`, (err as Error).message);
    }
  }

  /** Verifies the webhook exists before we start streaming into it. */
  async verify(): Promise<{ name: string; channel_id: string; guild_id?: string } | null> {
    try {
      return await http.request(this.routeKey, () => [this.base, { method: 'GET' }]);
    } catch (err) {
      this.handleFatal(err);
      return null;
    }
  }
}

import { http } from './http.js';
import type { AppConfig } from './config.js';
import type { Channel, Message, Role, User } from './types.js';

export const API = 'https://discord.com/api/v10';

/**
 * REST access using the *user* token. Mirrors send through webhooks (which need
 * no auth), so this client is only used for read-only lookups: fetching a
 * referenced message, resolving role/channel names, and the `list` helper.
 */
export class Rest {
  private readonly headers: Record<string, string>;

  constructor(private readonly config: AppConfig) {
    const props = {
      os: 'Windows',
      browser: 'Chrome',
      device: '',
      system_locale: 'en-US',
      has_client_mods: false,
      browser_user_agent: config.gateway.userAgent,
      browser_version: config.gateway.browserVersion,
      os_version: '10',
      referrer: '',
      referring_domain: '',
      referrer_current: '',
      referring_domain_current: '',
      release_channel: 'stable',
      client_build_number: config.gateway.clientBuildNumber,
      client_event_source: null,
    };

    this.headers = {
      Authorization: config.token,
      'User-Agent': config.gateway.userAgent,
      'X-Super-Properties': Buffer.from(JSON.stringify(props), 'utf8').toString('base64'),
      'X-Discord-Locale': 'en-US',
      'X-Debug-Options': 'bugReporterEnabled',
      'Accept-Language': 'en-US,en;q=0.9',
      Origin: 'https://discord.com',
      Referer: 'https://discord.com/channels/@me',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
    };
  }

  /** The identify properties, reused verbatim by the gateway. */
  get identifyProperties(): Record<string, unknown> {
    return JSON.parse(Buffer.from(this.headers['X-Super-Properties'], 'base64').toString('utf8'));
  }

  private get<T>(path: string, routeKey: string): Promise<T | null> {
    return http.request<T>(
      routeKey,
      () => [`${API}${path}`, { method: 'GET', headers: this.headers }],
      { allow404: true },
    );
  }

  me(): Promise<User | null> {
    return this.get<User>('/users/@me', 'GET:/users/@me');
  }

  guilds(): Promise<{ id: string; name: string }[] | null> {
    return this.get<{ id: string; name: string }[]>('/users/@me/guilds', 'GET:/users/@me/guilds');
  }

  guildChannels(guildId: string): Promise<Channel[] | null> {
    return this.get<Channel[]>(`/guilds/${guildId}/channels`, `GET:/guilds/${guildId}/channels`);
  }

  guildRoles(guildId: string): Promise<Role[] | null> {
    return this.get<Role[]>(`/guilds/${guildId}/roles`, `GET:/guilds/${guildId}/roles`);
  }

  channel(channelId: string): Promise<Channel | null> {
    return this.get<Channel>(`/channels/${channelId}`, `GET:/channels/${channelId}`);
  }

  /**
   * Fetch a single message. `GET /channels/:id/messages/:id` is bot-only, so
   * user tokens have to go through the list endpoint with `around`.
   */
  async message(channelId: string, messageId: string): Promise<Message | null> {
    const list = await this.get<Message[]>(
      `/channels/${channelId}/messages?limit=1&around=${messageId}`,
      `GET:/channels/${channelId}/messages`,
    );
    if (!Array.isArray(list)) return null;
    return list.find((m) => m.id === messageId) ?? null;
  }
}

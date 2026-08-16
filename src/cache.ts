import { logger } from './log.js';
import type { Rest } from './rest.js';
import type { Channel, Role } from './types.js';

const log = logger('cache');

const NEGATIVE_TTL = 5 * 60_000;

/**
 * Names for roles and channels so unmapped mentions can be rendered as readable
 * text instead of `@deleted-role`. Seeded from READY/GUILD_CREATE and topped up
 * with lazy REST lookups (each guild is fetched at most once per miss).
 */
export class DiscordCache {
  private roles = new Map<string, Map<string, Role>>();
  private channels = new Map<string, Channel>();
  private inFlight = new Map<string, Promise<unknown>>();
  private missedAt = new Map<string, number>();

  constructor(private readonly rest: Rest) {}

  /** READY (and GUILD_CREATE) carry the full role/channel lists for user accounts. */
  ingestGuild(guild: any): void {
    if (!guild) return;
    const id = String(guild.id ?? guild.properties?.id ?? '');
    if (!id) return;

    if (Array.isArray(guild.roles)) {
      const map = new Map<string, Role>();
      for (const role of guild.roles) map.set(String(role.id), { id: String(role.id), name: role.name, color: role.color });
      this.roles.set(id, map);
    }
    for (const list of [guild.channels, guild.threads]) {
      if (!Array.isArray(list)) continue;
      for (const channel of list) this.setChannel({ ...channel, guild_id: channel.guild_id ?? id });
    }
  }

  ingestReady(data: any): void {
    const guilds = Array.isArray(data?.guilds) ? data.guilds : [];
    for (const guild of guilds) this.ingestGuild(guild);
    log.debug(`cached ${this.roles.size} guild role sets, ${this.channels.size} channels from READY`);
  }

  setChannel(channel: Channel | any): void {
    if (!channel?.id) return;
    this.channels.set(String(channel.id), {
      id: String(channel.id),
      type: Number(channel.type ?? 0),
      guild_id: channel.guild_id ? String(channel.guild_id) : undefined,
      name: channel.name ?? undefined,
      parent_id: channel.parent_id ? String(channel.parent_id) : null,
    });
  }

  deleteChannel(id: string): void {
    this.channels.delete(id);
  }

  setRole(guildId: string, role: Role): void {
    let map = this.roles.get(guildId);
    if (!map) {
      map = new Map();
      this.roles.set(guildId, map);
    }
    map.set(String(role.id), { id: String(role.id), name: role.name, color: role.color });
  }

  deleteRole(guildId: string, roleId: string): void {
    this.roles.get(guildId)?.delete(roleId);
  }

  getChannelSync(id: string): Channel | undefined {
    return this.channels.get(id);
  }

  private recentlyMissed(key: string): boolean {
    const at = this.missedAt.get(key);
    return at !== undefined && Date.now() - at < NEGATIVE_TTL;
  }

  /** Deduplicates concurrent lookups for the same key. */
  private once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const promise = fn().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }

  async getChannel(id: string): Promise<Channel | undefined> {
    const cached = this.channels.get(id);
    if (cached) return cached;
    if (this.recentlyMissed(`channel:${id}`)) return undefined;

    return this.once(`channel:${id}`, async () => {
      try {
        const channel = await this.rest.channel(id);
        if (channel) {
          this.setChannel(channel);
          return this.channels.get(id);
        }
      } catch (err) {
        log.debug(`channel lookup failed for ${id}:`, (err as Error).message);
      }
      this.missedAt.set(`channel:${id}`, Date.now());
      return undefined;
    });
  }

  async getRoleName(guildId: string | undefined, roleId: string): Promise<string | undefined> {
    if (!guildId) return undefined;
    const cached = this.roles.get(guildId)?.get(roleId);
    if (cached) return cached.name;
    if (this.recentlyMissed(`roles:${guildId}`)) return undefined;

    return this.once(`roles:${guildId}`, async () => {
      try {
        const roles = await this.rest.guildRoles(guildId);
        if (roles) {
          const map = new Map<string, Role>();
          for (const role of roles) map.set(String(role.id), role);
          this.roles.set(guildId, map);
          return map.get(roleId)?.name;
        }
      } catch (err) {
        log.debug(`role lookup failed for guild ${guildId}:`, (err as Error).message);
      }
      this.missedAt.set(`roles:${guildId}`, Date.now());
      return undefined;
    });
  }
}

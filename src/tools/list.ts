import 'dotenv/config';
import { Rest } from '../rest.js';
import type { AppConfig } from '../config.js';

/**
 * `npm run list` — prints every guild, channel and role id the account can see,
 * so you can fill in config.json without hunting through developer mode.
 *
 * Optional argument filters guilds by name, e.g. `npm run list -- gaming`.
 */

const CHANNEL_KIND: Record<number, string> = {
  0: 'text',
  2: 'voice',
  4: 'category',
  5: 'news',
  10: 'news-thread',
  11: 'thread',
  12: 'private-thread',
  13: 'stage',
  15: 'forum',
  16: 'media',
};

const dim = (s: string) => `\x1b[90m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

async function main(): Promise<void> {
  const token = process.env.DISCORD_TOKEN?.trim();
  if (!token) throw new Error('DISCORD_TOKEN is not set. Copy .env.example to .env first.');

  const filter = process.argv.slice(2).join(' ').toLowerCase();

  // The list tool only needs a token, so build a minimal config shim.
  const config = {
    token,
    gateway: {
      clientBuildNumber: 431500,
      capabilities: 161789,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      browserVersion: '136.0.0.0',
    },
  } as AppConfig;

  const rest = new Rest(config);

  const me = await rest.me();
  if (!me) throw new Error('Token rejected by Discord.');
  console.log(`Signed in as ${bold(me.global_name ?? me.username)} (${me.id})\n`);

  const guilds = (await rest.guilds()) ?? [];
  const matching = filter ? guilds.filter((g) => g.name.toLowerCase().includes(filter)) : guilds;

  if (matching.length === 0) {
    console.log(filter ? `No guilds matching "${filter}".` : 'No guilds found.');
    return;
  }

  for (const guild of matching) {
    console.log(`${bold(guild.name)} ${dim(guild.id)}`);

    const [channels, roles] = await Promise.all([rest.guildChannels(guild.id), rest.guildRoles(guild.id)]);

    const categories = new Map<string, string>();
    for (const channel of channels ?? []) {
      if (channel.type === 4) categories.set(channel.id, channel.name ?? '');
    }

    const readable = (channels ?? [])
      .filter((c) => c.type !== 4 && [0, 5, 15, 16].includes(c.type))
      .sort((a, b) => (a.parent_id ?? '').localeCompare(b.parent_id ?? ''));

    console.log(dim('  channels'));
    for (const channel of readable) {
      const category = channel.parent_id ? categories.get(channel.parent_id) : undefined;
      const label = category ? `${category} / #${channel.name}` : `#${channel.name}`;
      console.log(`    ${cyan(channel.id)}  ${label} ${dim(`(${CHANNEL_KIND[channel.type] ?? channel.type})`)}`);
    }

    const mentionableRoles = (roles ?? []).filter((r) => r.name !== '@everyone');
    if (mentionableRoles.length) {
      console.log(dim('  roles'));
      for (const role of mentionableRoles) {
        console.log(`    ${yellow(role.id)}  @${role.name}`);
      }
    }
    console.log();
  }
}

main().catch((err: Error) => {
  console.error(`\x1b[31m${err.message}\x1b[0m`);
  process.exit(1);
});

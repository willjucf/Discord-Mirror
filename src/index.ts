import 'dotenv/config';
import { loadConfig } from './config.js';
import { logger } from './log.js';
import { Rest } from './rest.js';
import { Gateway } from './gateway.js';
import { DiscordCache } from './cache.js';
import { MirrorService } from './mirror.js';

const log = logger('main');

async function main(): Promise<void> {
  const config = loadConfig();
  const rest = new Rest(config);
  const cache = new DiscordCache(rest);
  const mirror = new MirrorService(config, cache, rest);

  const me = await rest.me().catch(() => null);
  if (!me) {
    throw new Error('Could not authenticate with DISCORD_TOKEN — the token is invalid or expired.');
  }
  mirror.setSelf(me.id);
  log.info(`authenticated as ${me.global_name ?? me.username} (${me.id})`);

  await mirror.verifyWebhooks();

  const gateway = new Gateway(config, rest);

  gateway.on('ready', (data) => {
    cache.ingestReady(data);
    const watching = config.byChannel.size;
    log.info(`gateway ready — watching ${watching} channel(s) across ${config.mirrors.length} mirror(s)`);
  });

  gateway.on('fatal', (err: Error) => {
    log.error(err.message);
    gateway.destroy();
    process.exitCode = 1;
  });

  gateway.on('dispatch', (type: string, data: any) => {
    switch (type) {
      case 'MESSAGE_CREATE':
        void mirror.handleCreate(data);
        break;
      case 'MESSAGE_UPDATE':
        void mirror.handleUpdate(data);
        break;
      case 'MESSAGE_DELETE':
        void mirror.handleDelete(data.id, data.channel_id);
        break;
      case 'MESSAGE_DELETE_BULK':
        void mirror.handleBulkDelete(data.ids ?? [], data.channel_id);
        break;

      // Keep the name caches warm so unmapped mentions stay readable.
      case 'GUILD_CREATE':
        cache.ingestGuild(data);
        break;
      case 'GUILD_ROLE_CREATE':
      case 'GUILD_ROLE_UPDATE':
        cache.setRole(data.guild_id, data.role);
        break;
      case 'GUILD_ROLE_DELETE':
        cache.deleteRole(data.guild_id, data.role_id);
        break;
      case 'CHANNEL_CREATE':
      case 'CHANNEL_UPDATE':
      case 'THREAD_CREATE':
      case 'THREAD_UPDATE':
        cache.setChannel(data);
        break;
      case 'CHANNEL_DELETE':
      case 'THREAD_DELETE':
        cache.deleteChannel(data.id);
        break;
    }
  });

  await gateway.connect();

  const shutdown = (signal: string) => {
    log.info(`${signal} received — shutting down`);
    gateway.destroy();
    // Give in-flight webhook requests a moment, then let the loop drain.
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => log.error('unhandled rejection:', reason));
}

main().catch((err: Error) => {
  log.error(err.message);
  process.exitCode = 1;
});

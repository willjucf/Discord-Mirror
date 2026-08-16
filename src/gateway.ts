import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { logger } from './log.js';
import { sleep } from './http.js';
import type { AppConfig } from './config.js';
import type { Rest } from './rest.js';

const log = logger('gateway');

const enum Op {
  DISPATCH = 0,
  HEARTBEAT = 1,
  IDENTIFY = 2,
  PRESENCE_UPDATE = 3,
  RESUME = 6,
  RECONNECT = 7,
  INVALID_SESSION = 9,
  HELLO = 10,
  HEARTBEAT_ACK = 11,
}

/** Close codes where reconnecting is pointless — the config or token is wrong. */
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

const DEFAULT_GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';

export interface GatewayEvents {
  dispatch: [type: string, data: any];
  ready: [data: any];
  fatal: [error: Error];
}

/**
 * Hand-rolled Discord gateway client.
 *
 * discord.js refuses user tokens, so we speak the protocol directly: HELLO →
 * IDENTIFY (user-shaped, with `capabilities` instead of `intents`) → heartbeat
 * loop, with RESUME on transient drops.
 */
export class Gateway extends EventEmitter {
  private ws?: WebSocket;
  private seq: number | null = null;
  private sessionId?: string;
  private resumeUrl?: string;
  private heartbeatTimer?: NodeJS.Timeout;
  private heartbeatInterval = 0;
  private awaitingAck = false;
  private backoff = 0;
  private shuttingDown = false;
  private connecting = false;

  constructor(
    private readonly config: AppConfig,
    private readonly rest: Rest,
  ) {
    super();
  }

  async connect(): Promise<void> {
    if (this.shuttingDown || this.connecting) return;
    this.connecting = true;

    const url = this.sessionId && this.resumeUrl ? `${this.resumeUrl}/?v=10&encoding=json` : DEFAULT_GATEWAY;
    log.debug(`connecting to ${url}`);

    const ws = new WebSocket(url, {
      headers: { 'User-Agent': this.config.gateway.userAgent },
    });
    this.ws = ws;

    ws.on('open', () => {
      this.connecting = false;
      log.debug('socket open');
    });

    ws.on('message', (raw) => {
      let payload: { op: number; d: any; s: number | null; t: string | null };
      try {
        payload = JSON.parse(raw.toString());
      } catch {
        log.warn('received unparseable frame');
        return;
      }
      this.handlePayload(payload);
    });

    ws.on('error', (err) => log.warn('socket error:', err.message));

    ws.on('close', (code, reason) => {
      this.connecting = false;
      this.stopHeartbeat();
      const text = reason.toString() || '(no reason)';

      if (this.shuttingDown) return;

      if (FATAL_CLOSE_CODES.has(code)) {
        const message =
          code === 4004
            ? 'Discord rejected the token (4004 Authentication failed). Grab a fresh DISCORD_TOKEN.'
            : `Gateway closed with unrecoverable code ${code}: ${text}`;
        this.emit('fatal', new Error(message));
        return;
      }

      // 4007/4009 invalidate the session; anything else can usually resume.
      if (code === 4007 || code === 4009) this.clearSession();
      log.warn(`socket closed (${code} ${text}) — reconnecting`);
      void this.scheduleReconnect();
    });
  }

  private clearSession(): void {
    this.sessionId = undefined;
    this.resumeUrl = undefined;
    this.seq = null;
  }

  private async scheduleReconnect(): Promise<void> {
    this.backoff = Math.min(60_000, this.backoff === 0 ? 1_000 : this.backoff * 2);
    const jitter = Math.floor(Math.random() * 500);
    log.debug(`reconnecting in ${this.backoff + jitter}ms`);
    await sleep(this.backoff + jitter);
    void this.connect();
  }

  private handlePayload(payload: { op: number; d: any; s: number | null; t: string | null }): void {
    if (payload.s !== null && payload.s !== undefined) this.seq = payload.s;

    switch (payload.op) {
      case Op.DISPATCH: {
        const type = payload.t!;
        if (type === 'READY') {
          this.backoff = 0;
          this.sessionId = payload.d?.session_id;
          this.resumeUrl = payload.d?.resume_gateway_url;
          this.emit('ready', payload.d);
        } else if (type === 'RESUMED') {
          this.backoff = 0;
          log.info('session resumed');
        }
        this.emit('dispatch', type, payload.d);
        break;
      }

      case Op.HEARTBEAT:
        this.sendHeartbeat();
        break;

      case Op.RECONNECT:
        log.info('gateway asked us to reconnect');
        this.reset(4000);
        break;

      case Op.INVALID_SESSION:
        if (payload.d === true) {
          log.warn('session invalidated but resumable');
        } else {
          log.warn('session invalidated — re-identifying');
          this.clearSession();
        }
        this.reset(4000);
        break;

      case Op.HELLO:
        this.heartbeatInterval = payload.d.heartbeat_interval;
        this.startHeartbeat();
        if (this.sessionId && this.seq !== null) this.resume();
        else this.identify();
        break;

      case Op.HEARTBEAT_ACK:
        this.awaitingAck = false;
        break;

      default:
        log.debug(`unhandled op ${payload.op}`);
    }
  }

  private reset(code: number): void {
    try {
      this.ws?.close(code, 'reconnecting');
    } catch {
      /* already gone */
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    // Discord asks for jitter on the first beat so clients don't sync up.
    const first = Math.floor(this.heartbeatInterval * Math.random());
    this.heartbeatTimer = setTimeout(() => {
      this.sendHeartbeat();
      this.heartbeatTimer = setInterval(() => {
        if (this.awaitingAck) {
          log.warn('heartbeat was never acked — assuming a zombie connection');
          this.reset(4000);
          return;
        }
        this.sendHeartbeat();
      }, this.heartbeatInterval);
    }, first);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.awaitingAck = false;
  }

  private sendHeartbeat(): void {
    this.awaitingAck = true;
    this.send({ op: Op.HEARTBEAT, d: this.seq });
  }

  private identify(): void {
    log.info('identifying');
    this.send({
      op: Op.IDENTIFY,
      d: {
        token: this.config.token,
        capabilities: this.config.gateway.capabilities,
        properties: this.rest.identifyProperties,
        presence: { status: 'unknown', since: 0, activities: [], afk: false },
        compress: false,
        client_state: {
          guild_versions: {},
          highest_last_message_id: '0',
          read_state_version: 0,
          user_guild_settings_version: -1,
          user_settings_version: -1,
          private_channels_version: '0',
          api_code_version: 0,
        },
      },
    });
  }

  private resume(): void {
    log.info('resuming session');
    this.send({
      op: Op.RESUME,
      d: { token: this.config.token, session_id: this.sessionId, seq: this.seq },
    });
  }

  private send(payload: unknown): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  destroy(): void {
    this.shuttingDown = true;
    this.stopHeartbeat();
    try {
      this.ws?.close(1000, 'shutting down');
    } catch {
      /* ignore */
    }
  }
}

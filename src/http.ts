import { logger } from './log.js';

const log = logger('http');

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: unknown,
  ) {
    super(`HTTP ${status} for ${url}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    this.name = 'HttpError';
  }
}

interface Bucket {
  /** Serialises requests that share a rate-limit bucket. */
  chain: Promise<unknown>;
  remaining: number;
  resetAt: number;
}

/**
 * Discord-aware HTTP client.
 *
 * Requests are serialised per route key so we never race ourselves through a
 * bucket, `x-ratelimit-*` headers are honoured pre-emptively, and 429s (both
 * per-route and global) are retried transparently.
 */
export class Http {
  private buckets = new Map<string, Bucket>();
  private globalUntil = 0;

  private bucket(key: string): Bucket {
    let b = this.buckets.get(key);
    if (!b) {
      b = { chain: Promise.resolve(), remaining: 1, resetAt: 0 };
      this.buckets.set(key, b);
    }
    return b;
  }

  /**
   * @param routeKey Requests with the same key are serialised (e.g. `POST:webhook:123`).
   * @param build    Returns a fresh [url, init] pair; called again on every retry
   *                 because request bodies (FormData/streams) are not reusable.
   */
  request<T = unknown>(
    routeKey: string,
    build: () => [string, RequestInit],
    opts: { retries?: number; allow404?: boolean } = {},
  ): Promise<T | null> {
    const bucket = this.bucket(routeKey);
    const run = () => this.execute<T>(routeKey, bucket, build, opts);
    const next = bucket.chain.then(run, run);
    // Keep the chain alive even when a request rejects.
    bucket.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async execute<T>(
    routeKey: string,
    bucket: Bucket,
    build: () => [string, RequestInit],
    opts: { retries?: number; allow404?: boolean },
  ): Promise<T | null> {
    const maxRetries = opts.retries ?? 5;

    for (let attempt = 0; ; attempt++) {
      const globalWait = this.globalUntil - Date.now();
      if (globalWait > 0) await sleep(globalWait);

      const bucketWait = bucket.resetAt - Date.now();
      if (bucket.remaining <= 0 && bucketWait > 0) await sleep(bucketWait + 50);

      const [url, init] = build();
      let res: Response;
      try {
        res = await fetch(url, init);
      } catch (err) {
        if (attempt >= maxRetries) throw err;
        const backoff = Math.min(30_000, 500 * 2 ** attempt);
        log.warn(`network error on ${routeKey}, retrying in ${backoff}ms:`, (err as Error).message);
        await sleep(backoff);
        continue;
      }

      const remaining = res.headers.get('x-ratelimit-remaining');
      const resetAfter = res.headers.get('x-ratelimit-reset-after');
      if (remaining !== null) bucket.remaining = Number(remaining);
      if (resetAfter !== null) bucket.resetAt = Date.now() + Number(resetAfter) * 1000;

      if (res.status === 429) {
        const body = (await res.json().catch(() => ({}))) as { retry_after?: number; global?: boolean };
        const retryAfter = (body.retry_after ?? 1) * 1000;
        if (body.global || res.headers.get('x-ratelimit-global') === 'true') {
          this.globalUntil = Date.now() + retryAfter;
          log.warn(`globally rate limited for ${retryAfter}ms`);
        } else {
          log.debug(`rate limited on ${routeKey} for ${retryAfter}ms`);
        }
        if (attempt >= maxRetries) throw new HttpError(429, url, body);
        await sleep(retryAfter + 100);
        continue;
      }

      if (res.status >= 500 && res.status < 600) {
        if (attempt >= maxRetries) throw new HttpError(res.status, url, await res.text().catch(() => ''));
        const backoff = Math.min(30_000, 500 * 2 ** attempt);
        await sleep(backoff);
        continue;
      }

      if (res.status === 404 && opts.allow404) return null;

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          /* keep raw text */
        }
        throw new HttpError(res.status, url, parsed);
      }

      if (res.status === 204) return null;
      const text = await res.text();
      if (!text) return null;
      return JSON.parse(text) as T;
    }
  }
}

export const http = new Http();

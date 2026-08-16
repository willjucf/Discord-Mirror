# discord-mirror

Mirrors messages from Discord channels your account can read into channels you control, using webhooks — with role and `@everyone`/`@here` ping remapping, working replies, re-uploaded media, and edit/delete syncing.

Built against the current Discord API (v10) and current message features: the new username system, message forwarding, polls, voice messages, Components V2, threads, and expiring signed CDN links.

> ### ⚠️ Read this before using it
>
> This drives a **user account** with a script — "self-botting". It violates [Discord's Terms of Service](https://discord.com/terms) and the account can be permanently disabled for it. That is inherent to mirroring a server you don't run; there is no compliant way to do it with a user token.
>
> Use an account you can afford to lose. If you have bot access to the source server, use a real bot instead — it's supported, safe, and this codebase ports over with only the gateway IDENTIFY changing.

---

## Contents

- [Features](#features)
- [What you need](#what-you-need)
- [Setup](#setup)
- [Running it](#running-it)
- [Configuration reference](#configuration-reference)
- [How it works](#how-it-works)
- [Troubleshooting](#troubleshooting)

---

## Features

| | |
|---|---|
| **Channel routing** | Any number of source channels → any number of webhooks. One channel can feed several mirrors. |
| **Role pings** | `@SourceRole` → whichever role you map it to. `"*"` maps *every* role to one alert role. Unmapped roles degrade to inert text (`@Moderators`) instead of `@deleted-role`. |
| **@everyone / @here** | Remapped to a role ping, a real `@everyone`, or nothing. Only fires when the source message *actually* pinged — someone merely typing "@everyone" gets neutralised. |
| **Replies** | A compact embed with the replied-to author, avatar, an excerpt, and a jump link **to the mirrored copy in your server** (falling back to the original when there isn't one). |
| **Images, video, GIFs** | Attachments are downloaded and re-uploaded so they live permanently in your server — Discord's CDN links are signed and expire in ~24h, so link-only mirroring rots. Oversize files fall back to links. |
| **Links** | Passed through so Discord generates its own preview. Author-made rich embeds are forwarded; Discord's auto-unfurls are dropped so you don't get doubles. |
| **Stickers** | Re-embedded as images. Lottie stickers degrade to a text note. |
| **Forwarded messages** | Rendered as a "⤷ Forwarded message" embed with the original content. |
| **Polls** | Question, options and current vote counts as an embed. |
| **Components V2** | Text, media and link buttons flattened into markdown (incoming webhooks can't send components). |
| **Threads** | Messages in threads under a mapped channel arrive tagged `🧵 thread-name`. |
| **Edits & deletes** | Mirrored messages are patched and removed to match the source. |
| **Identity** | Every message posts under the author's nickname and server avatar, so the mirror reads like the original channel. |
| **Filters** | Per-mirror allow/deny by user, bot, webhook, or regex. |
| **Reliability** | Per-bucket rate limiting with pre-emptive waits, 429/5xx retry, gateway `RESUME` with exponential backoff. |

---

## What you need

**1. Node.js 20.10 or newer.** Check with `node --version`. Get it from [nodejs.org](https://nodejs.org).

**2. A Discord account token.** The account must be a member of the source server and able to see the channels you want to mirror. See [step 2](#2-get-your-account-token).

**3. A destination server you can create webhooks in** — you need the **Manage Webhooks** permission, which normally means it's your own server.

**4. IDs**, all obtainable with `npm run list` once the token is set:

| | Where from | Used for |
|---|---|---|
| Source channel id(s) | source server | what to mirror |
| Webhook URL(s) | destination server | where to post |
| Role id(s) | **destination** server | what role pings become |

**5. For pings to actually notify**, in the destination server:
- the role you're mapping to must be **Mentionable** (Server Settings → Roles), and
- for a real `@everyone`, the webhook's channel must allow **"Mention @everyone, @here and All Roles"**.

Without these the ping renders as a ping but silently notifies nobody.

---

## Setup

### 1. Install

```bash
git clone https://github.com/YOUR_USERNAME/discord-mirror.git
cd discord-mirror
npm install
```

### 2. Get your account token

In the Discord **web** client (this does not work in the desktop app):

1. Press `F12` to open DevTools, go to the **Network** tab.
2. Send or open any message so requests appear.
3. Click any request to `/api/v*/`.
4. Under **Headers**, find `authorization` and copy its value.

That token is full access to your account — treat it like a password. It rotates when you change your password or log out, and you'll need to grab a fresh one when it does.

### 3. Create the webhook(s)

In the **destination** server, for each channel you want to mirror into:

**Server Settings → Integrations → Webhooks → New Webhook → pick the channel → Copy Webhook URL**

The webhook's own name and avatar don't matter — they're overridden on every message.

### 4. Fill in `.env`

```bash
cp .env.example .env
```

```env
DISCORD_TOKEN=your_token_here
WEBHOOK_MAIN=https://discord.com/api/webhooks/000000000000/xxxxxxxxxxxx
```

### 5. Find your IDs

```bash
npm run list              # every guild, channel and role the account can see
npm run list -- myserver  # filter guilds by name
```

```
Source Server 100000000000000001
  channels
    200000000000000002  general / #announcements (text)
  roles
    300000000000000003  @Subscribers

My Mirror Server 400000000000000004
  channels
    500000000000000005  mirrors / #feed (text)
  roles
    600000000000000006  @MirrorPing
```

You want the **channel id from the source server** and the **role id from your own server**.

### 6. Fill in `config.json`

```bash
cp config.example.json config.json
```

A minimal working config — mirror one channel, and make **any** role ping plus `@everyone`/`@here` all ping one alert role in your server:

```jsonc
{
  "mirrors": [
    {
      "name": "main",
      "source": ["200000000000000002"],   // source channel id
      "webhook": "env:WEBHOOK_MAIN",      // name of the .env variable
      "mentions": {
        "roles": { "*": "600000000000000006" },  // any role -> this role
        "everyone": "600000000000000006",
        "here": "600000000000000006"
      }
    }
  ]
}
```

`config.example.json` documents every available option inline. Both `.env` and `config.json` are gitignored.

---

## Running it

```bash
npm start
```

A healthy startup prints four lines:

```
INFO  main    authenticated as yourname (700000000000000007)
INFO  mirror  mirror "main": 1 source channel(s) -> webhook "Mirror Hook" in channel 500000000000000005
INFO  gateway identifying
INFO  main    gateway ready — watching 1 channel(s) across 1 mirror(s)
```

Each mirrored message then logs `[main] username: message`. `Ctrl+C` to stop.

| Command | |
|---|---|
| `npm start` | Run the mirror |
| `npm run dev` | Run with auto-restart on source edits |
| `npm run list` | Print visible guild / channel / role ids |
| `npm run typecheck` | TypeScript check without running |
| `npm run build` | Compile to `dist/` |

Verbose logging — shows payloads, rate-limit waits, and why messages were skipped:

```bash
LOG_LEVEL=debug npm start           # bash
$env:LOG_LEVEL="debug"; npm start   # PowerShell
```

---

## Configuration reference

`config.json` has three sections: `gateway` (rarely touched), `defaults`, and `mirrors`. **Every key in `defaults` can be overridden per mirror.** Comments and trailing commas are allowed.

### A mirror

```jsonc
{
  "name": "announcements",                 // label used in logs
  "source": ["111...", "222..."],          // one id or an array of source channel ids
  "webhook": "env:WEBHOOK_ANNOUNCEMENTS",  // env var name, or a raw URL
  "enabled": true,                         // set false to park a mirror without deleting it

  // Optional — auto-detected from the webhook, only set to override.
  "targetGuildId": "999...",
  "targetChannelId": "888..."
}
```

### Mentions

| Key | Meaning |
|---|---|
| `everyone` / `here` | What a real `@everyone` / `@here` becomes. Bare id → role ping, `"@everyone"` → a real server-wide ping, `null` → neutralised to inert text. |
| `roles` | `{ "sourceRoleId": "destRoleId" }`. The key `"*"` is a catch-all for any role without its own entry; explicit ids win over it. Values may be bare ids, `<@&id>`, or plain text. |
| `users` | Same shape for user mentions. Rarely needed. |
| `unmappedRoles` | `text` (default — inert `@RoleName`), `keep` (raw mention, shows as `@deleted-role`), `strip`. |
| `unmappedUsers` | Same options. |

`allowed_mentions` is computed from the *result* of the mapping, so the mirror can only ever ping exactly what you configured — a source ping can never leak through to an unmapped role.

### Attachments

```jsonc
"attachments": {
  "mode": "reupload",        // reupload | link | both | off
  "maxFileBytes": 24000000,
  "maxTotalBytes": 24000000,
  "maxFiles": 10
}
```

24 MB matches Discord's base upload limit. Raise to ~49 MB if the destination server is Boost Level 2, ~99 MB at Level 3. Anything over budget is posted as a link instead.

### Replies

```jsonc
"replies": { "enabled": true, "style": "embed", "maxLength": 200, "fetchMissing": true }
```

`style: "quote"` uses a one-line markdown blockquote instead of an embed — tidier when messages already carry embeds.

The jump link points at the mirrored copy in your server. If the replied-to message was never mirrored — posted before startup, filtered out, or aged out of the 5000-message map — it links to the source and the label changes to "Jump to original".

### Embeds

- `"rich"` (default) — forward author-made embeds, drop Discord's auto-generated link previews (the destination regenerates its own from the forwarded links).
- `"all"` — forward everything; expect duplicate previews.
- `"none"` — drop them.

### Filters

```jsonc
"filters": {
  "ignoreBots": false,
  "ignoreWebhooks": false,
  "ignoreSelf": true,      // don't mirror your own account's messages
  "ignoreUserIds": [],
  "onlyUserIds": [],       // allowlist; empty means everyone
  "includeRegex": null,    // only mirror when content matches
  "excludeRegex": null,    // skip when content matches
  "ignoreEmpty": true
}
```

### Everything else

| Key | Default | |
|---|---|---|
| `nameStyle` | `nickname` | `nickname` → `display` → `username` fallback chain. Also `display`, `username`. |
| `usernamePrefix` / `usernameSuffix` | `""` | Wraps the webhook username, e.g. a `" [EU]"` suffix. |
| `showSourceChannel` | `false` | Prepends a small `#channel` subtext line. |
| `threads` | `inline` | `inline` mirrors thread messages with a `🧵` tag; `off` ignores them. |
| `mirrorEdits` / `mirrorDeletes` | `true` | Tracked in a bounded in-memory map (5000 messages); cleared on restart. |
| `systemMessages` | `false` | Join / boost / pin notices. |
| `stickers`, `polls`, `forwards`, `componentsV2` | `true` | Toggle individual features. |
| `accentColor` | `5793266` | Decimal colour for reply / forward / poll embeds. |

---

## How it works

```
Discord gateway (user token)
        │  MESSAGE_CREATE / UPDATE / DELETE
        ▼
   src/mirror.ts      route channel -> mirrors, apply filters, track ids
        ▼
   src/build.ts       remap mentions, build reply/forward/poll embeds,
                      download attachments, split at 2000 chars
        ▼
   src/webhook.ts     POST /webhooks/:id/:token   (rate-limit aware)
```

| File | Responsibility |
|---|---|
| `src/gateway.ts` | Raw WebSocket gateway: identify, heartbeat, resume, backoff. |
| `src/http.ts` | Rate-limit-aware HTTP: per-bucket serialisation, 429/5xx retry. |
| `src/rest.ts` | Read-only REST with the user token (referenced messages, names). |
| `src/cache.ts` | Role and channel names, seeded from `READY`, topped up lazily. |
| `src/build.ts` | All message transformation. |
| `src/webhook.ts` | Webhook execute / edit / delete, multipart uploads. |
| `src/store.ts` | Source message id → webhook message ids, for edits, deletes and reply links. |
| `src/config.ts` | JSONC config loading, defaults merging, validation. |
| `src/tools/list.ts` | `npm run list` id discovery helper. |

discord.js is not used — it rejects user tokens outright, so the gateway protocol is implemented directly. The only runtime dependencies are `ws` and `dotenv`.

---

## Troubleshooting

**`Discord rejected the token (4004 Authentication failed)`**
The token is stale. Discord rotates it on password change and logout — grab a fresh one.

**`Could not authenticate with DISCORD_TOKEN`**
Same cause, caught at startup before connecting. Check for a stray space or quote in `.env`.

**Nothing mirrors at all**
The account has to actually see the source channel. Run `npm run list` — if the channel isn't there, it's a permissions problem, not a config one. If messages *are* logged but nothing appears in Discord, the problem is the webhook side.

**Pings render but don't notify anyone**
The destination role isn't **Mentionable**, or (for a real `@everyone`) the webhook's channel doesn't grant **"Mention @everyone, @here and All Roles"**.

**`webhook ... is dead (HTTP 404)`**
The webhook was deleted in the destination server. Re-create it and update `.env`. That mirror auto-disables rather than spamming failures.

**Messages arrive but images don't**
Check the log for download failures, raise `maxFileBytes`, or set `attachments.mode` to `"link"` to skip re-uploading.

**Messages are silently skipped**
Run with `LOG_LEVEL=debug` — it reports which filter dropped each one.

---

## License

MIT — see [LICENSE](LICENSE).

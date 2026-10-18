# Typing race

A typing race for Fluxer accounts. Everyone in a match gets the same passage, types it, and the server records who finished first. The site answers on whatever hostname reaches the Worker. The header shows that hostname, so `typing.fluxer.my`, a `workers.dev` host, and local `127.0.0.1:8787` are the same app. The page title stays "Typing race", and adds the current step during a race: countdown, racing, or results.

## Deploy on Workers, with static assets

Use a Cloudflare Worker, not Cloudflare Pages.

Pages can host the HTML, and Pages Functions can run the OAuth routes. The race itself cannot live there on its own. Every racer in a match has to share one sentence, one start time, and one finish order. That room is a Durable Object with the WebSocket hibernation API. Cloudflare's Workers versus Pages matrix says Durable Objects on Pages mean a second Worker plus a binding in both production and preview. On Workers, the site, the sign-in routes, and the race rooms are one deploy.

The source site lives in `public/`. `npm run build` (esbuild) writes `dist/`: one minified script and one minified stylesheet, each with a content hash in the filename. Wrangler serves `dist/`. Requests for `/api/*`, `/auth/*`, `/ws`, and `/index.html` run the Worker first. `/index.html` answers 301 to `/`. Everything else is an asset. Hashed files under `/a/` are cached for a year. HTML is `no-cache`, so the next visit picks up a new hash.

Attach any hostname whose zone is on the same Cloudflare account. `typing.fluxer.my` is one example. The Worker does not contain that name.

## What a match does

1. Sign in with Fluxer OAuth (`identify` scope, authorization code, PKCE `S256`).
2. Pick a ladder: Desktop, Mobile, or Cursor.
3. Queue, practice alone, or join an open room. Open rooms lists who is waiting and how many seats are left. A 4-character code still joins a room directly.
4. The lobby Durable Object gives the whole room one passage and one start time. A sprint is a short passage, a set is a medium passage, and a long race is a long passage. The queue only pairs racers who picked the same ladder and the same length.
5. A race Durable Object watches progress. The first completed passage it receives is first place. The race ends when everyone has finished, or when the clock runs out: 2 minutes, 4 minutes, or 6 minutes. Rematch keeps the same ladder and length. A practice rematch starts at once. A rated rematch starts when two or more people from that race click Rematch, on a new passage.
6. Rated matches update that ladder's Elo. Practice does not.

Desktop and Mobile are separate keyboard ladders. Cursor is mouse only: the page draws a keyboard and ignores letter keys. Touch on that ladder does not type. Each ladder has its own Elo, starting at 1000.

This is a small friendly race. Finish order is the order the server hears a completed sentence. The page ignores paste so a normal browser types one character at a time. There is no ban system and no keystroke profile. A modified client can still claim progress.

Passages are original prose. Desktop and Mobile share one pool. Cursor passages use only the characters on the on-screen keys. A visitor can practice without an account. Those runs stay in the browser. Ranked races still come from the server.

From the home screen, Race a bot runs a seeded opponent at a chosen pace, and Race your ghost replays your best finish for that ladder and length. Both are practice. They stay in this browser and do not change Elo or the leaderboard. The ranked queue still pairs two people.

## Local play

Wrangler 4 needs Node.js 22 or newer.

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate
npm run dev
```

`npm run dev` builds `dist/`, watches `public/`, and starts Wrangler on http://127.0.0.1:8787 . A save under `public/` rebuilds the hashed files. `npm run build` only writes `dist/`.

Open http://127.0.0.1:8787 . `.dev.vars` turns on a local name entry so you can race without Fluxer. That switch is not in `wrangler.jsonc`, so `wrangler deploy` does not enable it. Leave `ALLOW_DEV_LOGIN` unset, or set it to anything other than `true`, on the deployed Worker.

```bash
npm test
npm run test:live    # while wrangler dev is running
```

## Fluxer OAuth

Create an application with `POST /v1/oauth2/applications` while signed in to Fluxer (user session, not a bot token). The docs are at https://docs.fluxer.app/http-api/applications/ and https://docs.fluxer.app/http-api/oauth2/ . The client id is the application id. The client secret is returned once, from create or from reset client secret.

Register each public origin's callback exactly. Fluxer compares them byte for byte. HTTP is allowed only for localhost, a `.localhost` host, or an IP literal. Every other host has to be HTTPS.

The Worker builds the callback from the host the browser called, plus `/auth/callback`, unless `FLUXER_REDIRECT_URI` is set. Leave that secret unset when more than one hostname should be able to sign in. Set it only when every login should return to one host. Examples:

- `https://typing.fluxer.my/auth/callback`
- `http://127.0.0.1:8787/auth/callback` if you want to try OAuth locally

The site asks only for the `identify` scope. It stores the refresh token so sign-out can revoke the grant. Access tokens last 7 days, refresh tokens 30 days. The refresh token is encrypted with AES-GCM before it is written. The key is `TOKEN_ENCRYPTION_KEY`, a Worker secret, not the Fluxer client secret and not `SESSION_SECRET`. Generate it with `openssl rand -base64 32` and set it with `npx wrangler secret put TOKEN_ENCRYPTION_KEY`. Put that key in `.dev.vars` for local OAuth. Rows saved before that key existed are plaintext. The next signed-in request re-encrypts them. If the key is missing, a new login still works and the refresh token is not stored, so sign-out cannot revoke that grant.

Avatars use the hosted instance discovery document (`https://api.fluxer.app/.well-known/fluxer`): `endpoints.media` and `endpoints.static_cdn`. Those bases are `MEDIA_BASE` and `STATIC_CDN` in `wrangler.jsonc`.

## Deploy

```bash
npx wrangler d1 create typing-game
```

Put the printed database id in `wrangler.jsonc` in place of the all-zero local id. Apply the migration to the remote database:

```bash
npx wrangler d1 migrations apply typing-game --remote
```

Secrets:

```bash
npx wrangler secret put FLUXER_CLIENT_ID
npx wrangler secret put FLUXER_CLIENT_SECRET
openssl rand -base64 32
npx wrangler secret put SESSION_SECRET
openssl rand -base64 32
npx wrangler secret put TOKEN_ENCRYPTION_KEY
```

`FLUXER_CLIENT_ID` and `FLUXER_CLIENT_SECRET` come from the Fluxer application. `SESSION_SECRET` does not. Run `openssl rand -base64 32`, then paste that output when `wrangler secret put SESSION_SECRET` prompts. It signs the login cookie. Run the command again and paste the new output into `TOKEN_ENCRYPTION_KEY`. That key encrypts the refresh token. Use a different value from `SESSION_SECRET`. Set `TOKEN_ENCRYPTION_KEY` before or with the deploy that starts encrypting tokens. The Fluxer bot token is not used.

`ALLOWED_ORIGINS` is optional. WebSocket upgrades already allow the host that received the request. Set this secret or var only to add more origins, as a comma-separated list such as `https://preview.example`. A missing `Origin` header is refused.

The Worker cron `17 * * * *` deletes expired session rows in batches of 100, up to 10 batches per run. Finished race objects keep their storage for 2 minutes after the result is saved, then delete it. Rematch records expire after 3 minutes.

Optional: `npx wrangler secret put FLUXER_REDIRECT_URI` when every login must return to one host, such as `https://typing.fluxer.my/auth/callback`. Leave it unset and the callback follows the host in the address bar.

```bash
npm run deploy
```

`npm run deploy` builds `dist/` and then runs `wrangler deploy`. Link previews and the sitemap use `https://typing.fluxer.my/` as the public address. The Worker still answers on any hostname that reaches it.

Replace the `Contact` line in `public/.well-known/security.txt` before the site is public. `mailto:security@example.com` is a placeholder, and that mailbox is not monitored.

In the Cloudflare dashboard, attach the hostname to the `typing-fluxer` Worker. Or add the route once that zone is on the account and deploy again. For `typing.fluxer.my`:

```jsonc
"routes": [{ "pattern": "typing.fluxer.my", "custom_domain": true }]
```

Another hostname is the same line with that name. Each one you sign in from also needs its `/auth/callback` on the Fluxer application.

Do not set `ALLOW_DEV_LOGIN` to `true` in the deployed vars.

## Layout

- `public/` is the source site: one page, the unminified modules, and the stylesheet.
- `script/build.mjs` minifies that front end into `dist/`. Do not edit `dist/`.
- `src/index.js` routes HTTP and WebSocket upgrades.
- `src/lobby.js` is the queue and private rooms.
- `src/race.js` is one match: sentence, progress, finish order.
- `migrations/` is the D1 schema for accounts, sessions, and ladder rows.

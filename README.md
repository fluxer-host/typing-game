# typing.fluxer.games

A typing race for Fluxer accounts. Everyone in a match gets the same sentence, types it, and the server records who finished first.

## Deploy on Workers, with static assets

Use a Cloudflare Worker, not Cloudflare Pages.

Pages can host the HTML, and Pages Functions can run the OAuth routes. The race itself cannot live there on its own. Every racer in a match has to share one sentence, one start time, and one finish order. That room is a Durable Object with the WebSocket hibernation API. Cloudflare's Workers versus Pages matrix says Durable Objects on Pages mean a second Worker plus a binding in both production and preview. On Workers, the site, the sign-in routes, and the race rooms are one deploy.

Static files in `public/` are still served from the edge. Requests for `/api/*`, `/auth/*`, and `/ws` run the Worker first. Everything else is an asset.

The custom domain `typing.fluxer.games` attaches to that Worker after the zone is on the same Cloudflare account.

## What a match does

1. Sign in with Fluxer OAuth (`identify` scope, authorization code, PKCE `S256`).
2. Pick a ladder: Desktop, Mobile, or Cursor.
3. Queue, practice alone, or share a 4-character room.
4. The lobby Durable Object gives the whole room one sentence and one start time.
5. A race Durable Object watches progress. The first completed sentence it receives is first place. The race ends when everyone has finished or 120 seconds pass.
6. Rated matches update that ladder's Elo. Practice does not.

Desktop and Mobile are separate keyboard ladders. Cursor is mouse only: the page draws a keyboard and ignores letter keys. Touch on that ladder does not type. Each ladder has its own Elo, starting at 1000.

This is a small friendly race. Finish order is the order the server hears a completed sentence. The page ignores paste so a normal browser types one character at a time. There is no ban system and no keystroke profile. A modified client can still claim progress.

Sentences are original lines built from public Fluxer lore: the name, the flux capacitor, Plutonium, Visionary badges, and self-hosting. Cursor lines are the short ones.

## Local play

Wrangler 4 needs Node.js 22 or newer.

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate
npm run dev
```

Open http://127.0.0.1:8787 . `.dev.vars` turns on a local name entry so you can race without Fluxer. That switch is not in `wrangler.jsonc`, so `wrangler deploy` does not enable it. Leave `ALLOW_DEV_LOGIN` unset, or set it to anything other than `true`, on the deployed Worker.

```bash
npm test
npm run test:live    # while wrangler dev is running
```

## Fluxer OAuth

Create an application with `POST /v1/oauth2/applications` while signed in to Fluxer (user session, not a bot token). The docs are at https://docs.fluxer.app/http-api/applications/ and https://docs.fluxer.app/http-api/oauth2/ . The client id is the application id. The client secret is returned once, from create or from reset client secret.

Register these redirect URIs exactly. Fluxer compares them byte for byte. HTTP is allowed only for localhost, a `.localhost` host, or an IP literal. The public site has to be HTTPS.

- `https://typing.fluxer.games/auth/callback`
- `http://127.0.0.1:8787/auth/callback` if you want to try OAuth locally

The site asks only for the `identify` scope. It stores the refresh token so sign-out can revoke the grant. Access tokens last 7 days, refresh tokens 30 days.

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
npx wrangler secret put SESSION_SECRET
```

`SESSION_SECRET` should be a long random string. Optional: `npx wrangler secret put FLUXER_REDIRECT_URI` if the callback is not `{the worker origin}/auth/callback`.

```bash
npm run deploy
```

In the Cloudflare dashboard, attach `typing.fluxer.games` to the `typing-fluxer` Worker. Or add this to `wrangler.jsonc` once the zone is on the account and deploy again:

```jsonc
"routes": [{ "pattern": "typing.fluxer.games", "custom_domain": true }]
```

Do not set `ALLOW_DEV_LOGIN` to `true` in the deployed vars.

## Layout

- `public/` is the site: one page, no build step.
- `src/index.js` routes HTTP and WebSocket upgrades.
- `src/lobby.js` is the queue and private rooms.
- `src/race.js` is one match: sentence, progress, finish order.
- `migrations/` is the D1 schema for accounts, sessions, and ladder rows.

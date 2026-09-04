# Guitar cloud sync — Cloudflare Worker

A tiny sync backend for the Guitar PWA: one Worker + one D1 (SQLite) database,
all on Cloudflare's **free** plan (100k requests/day, no credit card, never
sleeps). Users sign in with a username + 6-digit passcode; their library is
merged with a server copy so no device overwrites another.

The same Worker also serves **`POST /song`** for the song-sheet feature: it
scrapes a chord sheet (Ultimate Guitar first, then e-chords), converts it to
the plain "chords above the lyrics" text `../js/songsheet.js` parses, caches
it in the D1 table `sheets`, and returns it. Open endpoint, rate-limited to
40 upstream fetches per IP per hour (cache hits don't count). Request body
`{ artist, title }` or `{ url }`, optional `{ refresh: true }` to bypass the
cache.

## Shipping the /song update to the live Worker

1. **Schema:** Cloudflare dashboard → **D1** → `guitar-sync` → **Console**,
   paste the two new `CREATE TABLE` blocks from `schema.sql` (`sheets` and
   `fetch_attempts`) and run them. `CREATE TABLE IF NOT EXISTS` is safe to
   re-run, so pasting the whole file also works.
2. **Code:** Workers & Pages → `guitar-sync` → **Edit code** → replace with
   `src/worker.js` → **Deploy**.
3. Quick check:
   `curl -X POST https://guitar-sync.julianleendertse.workers.dev/song -H 'content-type: application/json' -d '{"artist":"bob dylan","title":"knockin on heavens door"}'`
   → JSON with a `raw` chord sheet (or `{"error":...,"tried":[...]}` if both
   sources were blocked — then the app falls back to the paste box).

## Already deployed (2026-09-03)

- Worker: **https://guitar-sync.julianleendertse.workers.dev** (this is the
  value of `SYNC_URL` in `../js/sync.js`)
- D1 database `guitar-sync`, id `4bde485e-a1fa-4ee3-ae78-99f478fd299b`
- Account `7251c5e4dde742756b7a88fbb40d4526` (KipKroket, GitHub login)
- Schema from `schema.sql` applied; deployed via the dashboard (Workers →
  Edit code) because this Mac has no Node/wrangler.

To ship a code change without wrangler: Cloudflare dashboard → Workers &
Pages → guitar-sync → Edit code → paste `src/worker.js` → Deploy. The D1
binding (`DB`) and the schema persist across code deploys. The steps below
are the from-scratch path (e.g. redeploying on another machine that has
Node).

## What you need once

- A free Cloudflare account — sign up at <https://dash.cloudflare.com/sign-up>
  (email only, no card).
- Node.js installed (for `npx`). Check with `node -v`.

## Deploy (about 5 minutes)

Run these from this `server/` folder.

```bash
# 1. Log in (opens a browser to authorise)
npx wrangler login

# 2. Create the database
npx wrangler d1 create guitar-sync
```

Step 2 prints a block like:

```
[[d1_databases]]
binding = "DB"
database_name = "guitar-sync"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Copy that `database_id` value into **`wrangler.toml`** (replace
`REPLACE_WITH_ID_FROM_wrangler_d1_create`).

```bash
# 3. Create the tables (in the real, remote database)
npx wrangler d1 execute guitar-sync --remote --file=./schema.sql

# 4. Deploy the Worker
npx wrangler deploy
```

Step 4 prints the URL, e.g.:

```
https://guitar-sync.your-subdomain.workers.dev
```

## Wire it into the app

Give that URL to Claude, or do it yourself: open `../js/sync.js` (i.e.
`app/js/sync.js`), set

```js
const SYNC_URL = "https://guitar-sync.your-subdomain.workers.dev";
```

then bump `BUILD` in `../js/app.js` and `CACHE` in `../sw.js`, and
`git push` from the `app/` folder. The Settings page will then show an
"Account & sync" section.

## Quick check

```bash
curl -X POST https://guitar-sync.your-subdomain.workers.dev/login \
  -H 'content-type: application/json' -d '{"username":"nobody","passcode":"000000"}'
# -> {"error":"Wrong username or passcode"}  (means it's alive)
```

## Notes

- **Cost:** free tier only. Cloudflare never auto-charges; going over a limit
  just returns errors until the next day.
- **Security proportionate to the data (song lists):** passcodes are stored
  as PBKDF2-SHA256 hashes, never plaintext; failed logins are rate-limited to
  10 per username per hour; all traffic is HTTPS. A 6-digit passcode is not
  bank-grade — that's a deliberate trade for "no email, easy for friends".
- **Anyone can register.** If that becomes a problem, add a shared invite
  code check at the top of `register()` in `src/worker.js`.
- **Data model:** one row per user in `users`, `libraries` column is JSON.
  One row per signed-in device in `sessions`. Inspect with
  `npx wrangler d1 execute guitar-sync --remote --command "SELECT username, updated_at FROM users"`.
- **iOS Safari note:** this is a plain no-cookie CORS `fetch()` to your own
  Worker, which works fine on iOS (unlike the cross-site music-search calls,
  which is why those use JSONP).

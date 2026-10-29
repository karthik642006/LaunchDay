# LaunchDay

A Product Hunt-style daily product launch community, built as an installable web app (PWA)
so you can update it every day **without users ever updating the app**.

## Run

```bash
npm install
npm start            # http://localhost:3000
```

Needs Node.js 22.5+ (uses the built-in `node:sqlite`). Demo login: `demo` / `demo1234`.

| Env var        | Default            | Purpose                                              |
| -------------- | ------------------ | ---------------------------------------------------- |
| `PORT`         | `3000`             | HTTP port                                            |
| `APP_TIMEZONE` | `UTC`              | When a "day" starts, e.g. `Asia/Kolkata`             |
| `ADMIN_TOKEN`  | _(admin disabled)_ | Enables `/api/admin/*`                               |
| `DB_PATH`      | `./launchday.db`   | SQLite file                                          |
| `SEED_DEMO`    | `true`             | `false` skips demo launches on a fresh database      |
| `MONGODB_URI`  | _(Mongo disabled)_ | Atlas connection string; keep it in `.env` only      |
| `MONGODB_DB`   | `founder_marketplace` | MongoDB database name                             |

`npm start` loads `.env` automatically (copy `.env.example`). With MongoDB configured:
`GET /api/health` checks the database connection, and `GET /api/startups?limit=&cursor=&category=&stage=&q=`
lists public startup listings.

## Features

- Daily leaderboard of launches ranked by upvotes, with day-by-day browsing
- Product pages: upvote, threaded discussion, share, visit website
- Topics with follow, and a personalized "For you" feed (last 7 days of followed topics)
- Submit or schedule launches (up to 3 topics each)
- Automatic 🥇🥈🥉 "Product of the Day" badges when each day ends
- "Yesterday's Top 5" daily digest
- Search, user profiles (made / upvoted), accounts
- Works offline for pages already visited; installs to the home screen on Android, iOS and desktop

## How daily updates reach users with no app update

There are three layers, from no-deploy to deploy:

1. **Content (no deploy).** Launches, votes, comments and digests are all read from the server
   live. Schedule tomorrow's launches today and they appear at midnight (`APP_TIMEZONE`).

2. **Server-driven UI (no deploy).** The app builds its home screen, banner, theme colour and
   feature switches from `/api/config`. Change them with one request:

   ```bash
   # Change the banner
   curl -X PUT localhost:3000/api/admin/config/banner -H "x-admin-token: $ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"value":{"text":"AI week starts today!","link":"#/t/ai","style":"success"}}'

   # Reorder or remove home sections: banner, today, yesterday, topics
   curl -X PUT localhost:3000/api/admin/config/home_sections -H "x-admin-token: $ADMIN_TOKEN" \
     -H "Content-Type: application/json" -d '{"value":["banner","yesterday","today"]}'

   # Turn features on/off: comments, digest, personalized_feed, submissions
   curl -X PUT localhost:3000/api/admin/config/features -H "x-admin-token: $ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"value":{"comments":true,"digest":true,"personalized_feed":true,"submissions":false}}'

   # Schedule a launch for a future day
   curl -X POST localhost:3000/api/admin/products -H "x-admin-token: $ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"name":"Acme","tagline":"Does a thing","url":"https://acme.example","launch_date":"2026-11-01","topics":["ai"]}'
   ```

3. **Code (deploy, still no user action).** Edit anything in `public/` and deploy. The server
   derives a version from the file contents (`/api/version`). Every installed app checks it on
   open, when brought back to the foreground, and every 10 minutes, then reloads itself into
   the new version. If the user is in the middle of typing, it shows a "tap to update" toast
   instead of interrupting. HTML and the service worker are never cached by the browser, and
   the service worker is network-first, so nobody gets stuck on an old version.

## Putting it in the app stores (optional)

The same deployed site can be wrapped without losing live updates:

- **Android / Play Store:** a Trusted Web Activity (e.g. with Bubblewrap or PWABuilder) that
  points at your HTTPS URL.
- **iOS / App Store:** a Capacitor shell with `server.url` set to your HTTPS URL. Apple requires
  some native value beyond a plain website (e.g. push notifications), so plan for that.

Either way the store build is a thin shell: you republish it only for native-level changes,
never for daily feature or content updates.

## Deploying

Any Node host works (Render, Railway, Fly.io, a VPS). Serve over HTTPS (service workers and
installation require it), set `NODE_ENV=production` for secure cookies, and keep `DB_PATH` on a
persistent disk.

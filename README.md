# Basketball Stats Tracker

A mobile-first web app for logging your team's stats live from the sideline. Plain HTML, CSS and JS with no build step. It's hosted on GitHub Pages and syncs between coaches through Supabase.

## Run it locally

```sh
cd ~/Projects/basketball-stats
python3 -m http.server 8000
```

Open http://localhost:8000 and enter the team code (2478).

If `js/config.js` has no Supabase keys, the app runs in **local mode**. Data stays in that browser, and tabs on the same device sync with each other. That's fine for trying it out. Live sync between coaches needs Supabase.

## Set up Supabase (free tier)

1. Create a project at https://supabase.com.
2. Open **SQL Editor → New query**, paste in `supabase/schema.sql` and run it.
3. Go to **Project Settings → API** and copy the **Project URL** and the **anon public** key into `js/config.js`:
   ```js
   supabaseUrl: 'https://xxxx.supabase.co',
   supabaseAnonKey: 'eyJ...',
   ```
4. Reload the app. The badge in the top right should say **Synced**.

Note: free projects pause after about a week with no activity. Open the dashboard and restore the project before a game if it has been idle.

## Publish on GitHub Pages

1. Create a GitHub repo and push this folder to it.
2. Go to **Settings → Pages**, choose "Deploy from a branch", pick `main` and `/ (root)`.
3. The site goes live at `https://<user>.github.io/<repo>/`. On a phone, use **Add to Home Screen** so it opens full screen.

## How it works

- Every stat comes from the `events` table, so undo, edit and delete just change events.
- Each write goes into an on-device cache and an outbox first, so taps never wait on the network. The outbox keeps retrying until Supabase accepts the write. The badge shows "N to sync" while writes are queued and "Offline" when there's no realtime connection.
- Other coaches' changes arrive over Supabase realtime. The coach names next to the badge are the other people with the same game open.
- Undo works per device. It steps back through *your* last 50 actions in a game, so it never removes another coach's entries. Use the Log tab to fix anything else.
- Period and lineup are stored on the game, so they're shared by every coach.
- Recent hot hand covers the last 5 minutes of logged play, measured from the latest event, so breaks in play don't empty it. Change `recentMinutes` in `config.js` to adjust.

## Security (MVP)

The access code and the Supabase anon key are both in the client, so anyone who reads the page source can get them. That's acceptable for a casual deterrent but not for real protection. The next step would be Supabase Auth with RLS policies scoped to logged-in coaches.

## Files

- `index.html`: shell
- `css/app.css`: styles (portrait, landscape and small-phone layouts)
- `js/app.js`: screens and actions
- `js/store.js`: data layer (cache, outbox, realtime, presence)
- `js/stats.js`: stat calculations
- `js/config.js`: Supabase keys, access code
- `sw.js`: offline support
- `supabase/schema.sql`: database

# Cyber Entertainment — website, store and admin panel

Static pages in `public/` + one serverless function (`api/index.js` → `lib/app.js`) for the API, bookings, admin panel and image serving.

## Run locally

```bash
npm start            # http://localhost:3000  — admin at /admin
```

No install needed locally (zero dependencies). Data is stored in `data/db.json` and `data/media/`.
To choose the admin password on a brand-new database: `ADMIN_PASSWORD='your-long-password' npm start`.

## Deploy on Vercel

1. **Push this code to your Git repo** (it replaces the old `server.js`).
2. In Vercel → *Project → Settings → General*: **Framework Preset = Other**, leave Build Command / Output Directory empty, Node.js **24.x**.
3. **Create a Blob store**: *Storage → Create → Blob → **Private*** → connect it to this project for all environments.
   This adds `BLOB_READ_WRITE_TOKEN` automatically. (Without it the site still works, but the admin can't save — see below.)
4. *Settings → Environment Variables* (recommended):
   - `SESSION_SECRET` — any long random string.
   - `BLOB_ACCESS` — only set to `public` if you created a *public* Blob store (private is recommended).
   - `ADMIN_PASSWORD` — only used when the database has no admin yet (the bundled `data/db.json` already contains your admin).
5. **Redeploy**, then open `/api/health`. You should see `{"ok":true,"storage":"blob", ...}`.

On the first request the bundled `data/db.json` is copied into Blob. From then on, all admin changes live in Blob (the file in Git is only the starting seed).
Seed photos in `data/media/` are served by the function; new uploads go to Blob and are served through the same `/media/...` URLs.

### `/api/health` tells you what's wrong

| `storage` | Meaning |
|---|---|
| `blob` | Everything is connected. |
| `readonly` | No Blob store connected: public site works, admin saves return a clear message. Do step 3, redeploy. |
| `local` | Running on your own machine. |

### Limits on Vercel

- Image uploads: **max 4 MB** (Vercel rejects larger request bodies). jpg / png / webp.
- Audio uploads are not supported on the live site — paste a direct audio link or a YouTube/SoundCloud link in the Mixtapes tab.
- Login rate-limiting is per serverless instance (best effort).

## Admin

Bookings (status, notes, CSV export), Events, DJs, Mixtapes, T-shirts, Gear, Settings, Account (password).
Admin sessions are signed cookies (HttpOnly, 8 h); changing the password signs everyone out.

## Security notes

- `data/db.json` contains the admin password **hash** — keep the repository private, and don't commit `.env` files.
- Use a **private** Blob store; the database (including bookings with phone numbers) is stored there.
- `/admin` and `/api/` are excluded from search engines (`robots.txt`, `X-Robots-Tag`).

## Backups

Local: copy `data/db.json` and `data/media/`. Vercel: download `cyber-entertainment/db.json` and `media/*` from the Blob store (or use *Admin → Bookings → Export CSV* regularly).

# Naukari Profile Updater

Keeps a Naukri profile fresh: cycles a trailing dot on the headline/summary, renames a resume copy, and re-uploads it on a schedule.

Two ways to run:

1. **Desktop (Electron)** — local Chrome session on your PC  
2. **Web (Render + Supabase)** — share a URL with friends; each browser gets its own session

> Open web URL has **no app login**. Anyone with the link can use it. Trusted friends only. Automating Naukri may conflict with their terms of use.

## Setup

```bash
npm install
```

## Desktop run

```bash
npm start
```

Background / tray:

```bash
npm run start:bg
```

## Web run (local)

1. Copy `.env.example` → `.env` and set `SUPABASE_SERVICE_ROLE_KEY` (Supabase → Project Settings → API → `service_role`).
2. `npx playwright install chromium`
3. `npm run start:web` → http://localhost:3000

## Web deploy (Render free)

1. Use repo `render.yaml` or set the existing **Profile-Updater** service:
   - **Build:** `npm install && npm run build`
   - **Start:** `npm run start:web` (not `electron`)
2. Env vars: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `NODE_ENV=production`
3. Free Render cron jobs are paid-only — use a free external cron (e.g. cron-job.org) every 5 minutes:  
   `POST https://<your-service>.onrender.com/internal/tick` with header `x-cron-secret: <CRON_SECRET>`

Supabase project: **Profile-Updater** (`stpbrwrfblijjycuvmkn`).

Closing the window hides to the **system tray** — the scheduler keeps running. Use the tray icon → **Quit** to stop fully.

## Usage

1. Click **Connect Naukri account** — Chrome opens; sign into Naukri once. The session stays in this app’s Chrome profile on your PC (no password stored).
2. Choose a **resume PDF** first.
3. Optionally fill **First name**, **Last name**, and **Role**. If you leave them blank, values are taken from the selected resume file name. Each run still force-renames the upload copy.
4. Under **Profile text update**, choose **Add trailing dots** (Resume headline + Profile summary) or **Set custom text** with a separate box for each field.
5. Optionally enable the daily schedule and add up to **4** automation times (type hour/minute or use +/−, AM/PM).
6. Settings **auto-save** as you edit (no Save button needed).
7. Click **Run now** to bump headline/summary and upload the renamed resume immediately.

When already connected, the account button shows **Reconnect** (not “Connect” again).

Scheduled runs need the **process** alive (tray is enough — window can be closed).

Resume copies are named (date = your PC’s local calendar day at run time):

`FirstName_LastName_Role_Resume_YYYY-MM-DD.pdf`

## Tests

```bash
npm test
```

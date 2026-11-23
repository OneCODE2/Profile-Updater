# Profile Updater Web (Render + Supabase) — Design

**Date:** 2026-11-23  
**Status:** Draft for user review  
**Constraint:** Free Render + free Supabase only

## 1. Goal

Ship the same Naukari profile-updater features as the current Electron app, as a public website friends can open. Each visitor uses their own Naukri account. No app signup (open URL). Data that must survive sleep/restarts lives in Supabase.

## 2. Architecture

```
Browser
  ├── UI (ported from ui/)
  └── anonymous httpOnly cookie `sid`
        ↕ HTTPS
Render free Web Service (Node)
  ├── static UI + JSON API
  ├── Playwright + Chromium (queue: 1 concurrent run)
  └── no durable local disk
        ↕
Supabase free (project: Profile-Updater, ref stpbrwrfblijjycuvmkn, region ap-south-1)
  ├── Postgres: settings, storageState, logs metadata
  └── Storage: resume PDFs

Render free Cron Job (every 1–5 min)
  → GET/POST web service /internal/tick?secret=CRON_SECRET
  → loads due users from Supabase, enqueues runs
```

**Reuse:** `electron/naukri-helpers.js`, `electron/scheduler.js`, `electron/resume-name.js`, core of `electron/naukri-runner.js` (headless Chromium instead of `channel: "chrome"`).

**Replace:** Electron `main` / `preload` / tray with Express (or Fastify) HTTP server.

**Queue:** Global in-process mutex so only one Playwright browser runs at a time (free 512MB RAM).

## 3. Connect Naukri (cloud)

1. User clicks Connect.
2. Server creates/loads Playwright context for that `sid`.
3. Opens Naukri login URL.
4. UI polls screenshots (or shows a simple frame of latest screenshot + “I’ve logged in” / auto-detect profile URL).
5. When profile URL detected (same `onProfile` logic as today), save Playwright `storageState` JSON to Supabase and mark `connected_at`.
6. Later Run now / cron: launch headless with that `storageState`; on success write updated state back.

**Fallback if screenshot stream is too heavy for free RAM:** open login, return a one-time “paste session” is **out of scope**; prefer screenshot poll at low FPS (e.g. 1 fps) for Connect only.

## 4. Feature parity

| Desktop today | Web |
|---------------|-----|
| Connect / Reconnect | §3 |
| Dot / custom bump (headline + summary) | same helpers |
| Resume pick + rename upload | upload to Supabase Storage; run downloads to temp |
| Identity fields + resolve from filename | same |
| Schedule ≤4 slots + enable toggle | same scheduler; cron drives ticks |
| Run now | API |
| Auto-save settings | PATCH settings → Supabase |
| Status + log tail | from Supabase / run response |
| Tray / background process | N/A — cron replaces always-on process |

## 5. Data model (Supabase)

### Table `visitors`

| Column | Type | Notes |
|--------|------|--------|
| id | uuid PK | = `sid` cookie |
| settings | jsonb | mirrors store DEFAULTS + slots |
| storage_state | jsonb nullable | Playwright storageState; **sensitive** |
| connected_at | timestamptz nullable | |
| last_run_at | timestamptz nullable | |
| last_run_result | text nullable | |
| resume_path | text nullable | Storage object path |
| log_tail | text | capped |
| created_at / updated_at | timestamptz | |

### Storage bucket `resumes`

- Path: `{visitor_id}/{filename}.pdf`
- Private; only service role on server reads/writes

### RLS

- No anon direct access to `storage_state` or resumes.
- Server uses **service role** key only (Render env). Browser never gets service role.
- Optional later: RLS denied for all anon; API is the only door.

### Cron secret

- `CRON_SECRET` env on Render; `/internal/tick` rejects missing/wrong secret.

## 6. API (sketch)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/state` | settings + connected + logTail + running |
| PATCH | `/api/settings` | auto-save partial settings |
| POST | `/api/resume` | multipart PDF upload |
| POST | `/api/connect/start` | start connect session |
| GET | `/api/connect/snapshot` | latest JPEG for login UI |
| POST | `/api/connect/cancel` | abort |
| POST | `/api/run` | Run now |
| POST | `/internal/tick` | cron; run due schedules |

Middleware: ensure `sid` cookie (create uuid if missing).

## 7. Free-tier limits (accepted)

- One Playwright run at a time; others wait or get “busy, retry”.
- Cold starts: first request after sleep is slow; cron wakes service.
- Chromium may still OOM under load — keep deps lean, close browser always in `finally`.
- Open URL: anyone with the link can create a visitor and run automation — acceptable for trusted friends only.
- Naukri ToS / bot detection risk — product warning in UI README.

## 8. Render service config

- **Build:** install Playwright Chromium + `npm install` (electron not needed for web deploy).
- **Start:** `node server/index.js` (not `electron .`).
- **Env:** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `PORT`.
- Keep existing failed Electron web service settings replaced by the above (same GitHub repo is fine).

## 9. Testing

- Keep unit tests for helpers/scheduler/resume-name.
- Add API tests with mocked Playwright + Supabase where practical.
- Manual: Connect + Run now on free Render after deploy.

## 10. Out of scope (v1)

- Email/password app auth  
- Admin UI  
- Paid always-on / persistent disk  
- Streaming full interactive remote desktop  
- Multi-region  

## 11. Decisions locked

- Approach: web rewrite on Render  
- Access: open URL + anonymous `sid`  
- Users: few friends, each own Naukri account  
- Features: full parity with desktop (minus tray)  
- Data: Supabase free project **Profile-Updater** (`stpbrwrfblijjycuvmkn`)  
- Cost: $0 project create confirmed  

## 12. Success criteria

1. Friend opens Render URL, connects Naukri, uploads resume, Run now updates profile.  
2. Scheduled slots fire via cron without the friend’s browser open.  
3. Two friends get isolated sessions/settings.  
4. Electron local app can remain for personal use; web is the shared deploy path.

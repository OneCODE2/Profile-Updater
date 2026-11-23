# Profile Updater Web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy a free Render web app with the same Naukari updater features as the Electron app, storing per-visitor data in Supabase project `stpbrwrfblijjycuvmkn`.

**Architecture:** Node HTTP server + ported UI; Playwright headless on server (single-run queue); anonymous `sid` cookie; Supabase Postgres + Storage; Render Cron hits `/internal/tick`.

**Tech Stack:** Node, Express (or Fastify), Playwright (bundled Chromium), `@supabase/supabase-js`, existing `naukri-helpers` / `scheduler` / `resume-name`, Render free + Supabase free.

**Spec:** `docs/superpowers/specs/2026-11-23-profile-updater-web-design.md`

---

## File map

| Path | Responsibility |
|------|----------------|
| `server/index.js` | HTTP app, cookie `sid`, routes, cron auth |
| `server/supabase.js` | Service-role client |
| `server/visitors.js` | Load/save visitor row + resume |
| `server/queue.js` | One-at-a-time Playwright mutex |
| `server/connect.js` | Connect session + snapshot |
| `server/run.js` | Run now + scheduled run |
| `server/naukri-runner.js` | Copied/adapted from electron (headless + storageState) |
| `lib/naukri-helpers.js` | Move/reuse from electron |
| `lib/scheduler.js` | Move/reuse |
| `lib/resume-name.js` | Move/reuse |
| `public/` | Port of `ui/` (fetch API instead of preload) |
| `supabase/migrations/001_visitors.sql` | Schema + storage bucket notes |
| `package.json` | Web scripts; electron stays optional for local desktop |
| `render.yaml` (optional) | Web + cron blueprint |

---

### Task 1: Supabase schema

**Files:** migration via Supabase MCP / `supabase/migrations/001_visitors.sql`

- [ ] Apply migration creating `visitors` table (columns per spec §5)
- [ ] Create private Storage bucket `resumes`
- [ ] Verify with `list_tables` / list buckets
- [ ] Confirm RLS: no public read of `storage_state`

### Task 2: Package + server skeleton

**Files:** `package.json`, `server/index.js`, `server/supabase.js`

- [ ] Add deps: `express`, `cookie-parser`, `multer`, `@supabase/supabase-js`, `playwright` (or keep `playwright-core` + install chromium in build)
- [ ] Add scripts: `server`, `start:web`
- [ ] Health `GET /` serves public UI; `GET /api/health`
- [ ] `sid` cookie middleware (uuid v4, httpOnly, sameSite=lax, secure in prod)
- [ ] Env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`

### Task 3: Visitor persistence

**Files:** `server/visitors.js`

- [ ] `getOrCreateVisitor(sid)`
- [ ] `updateSettings(sid, partial)`
- [ ] `saveStorageState` / `loadStorageState`
- [ ] `uploadResume` / `downloadResumeToTemp`
- [ ] Unit-style test or small script against Supabase (optional smoke)

### Task 4: Extract shared libs

**Files:** `lib/*` from `electron/*`

- [ ] Copy helpers/scheduler/resume-name to `lib/` (or require from electron paths)
- [ ] Keep existing `test/*.test.js` passing (`npm test`)

### Task 5: Headless naukri-runner

**Files:** `server/naukri-runner.js`, `server/queue.js`

- [ ] Adapt launch: Chromium headless, `storageState` in/out (no persistent chrome-profile dir required)
- [ ] `runProfileUpdate` returns `{ ok, error?, storageState? }`
- [ ] Queue wrapper: reject or wait if busy
- [ ] Always close browser in `finally`

### Task 6: Connect flow API + UI

**Files:** `server/connect.js`, `public/*`

- [ ] `POST /api/connect/start`, `GET /api/connect/snapshot`, `POST /api/connect/cancel`
- [ ] Detect profile URL → persist storageState
- [ ] UI: Connect button shows snapshot img + status (replace “Opens Chrome on this PC” copy)

### Task 7: Settings, resume, Run now

**Files:** `server/index.js`, `server/run.js`, `public/renderer.js`

- [ ] Port UI fetch wiring from preload IPC
- [ ] PATCH settings, POST resume, POST run
- [ ] Mirror status/log behavior

### Task 8: Cron tick

**Files:** `server/index.js`, Render cron config

- [ ] `POST /internal/tick` with `CRON_SECRET`
- [ ] Query visitors with `scheduleEnabled` + due slots (reuse `slotsDueNow`)
- [ ] Enqueue runs through same queue
- [ ] Document cron setup on Render (every 5 min → service URL)

### Task 9: Render deploy

**Files:** `package.json` build/start, optional `render.yaml`, README

- [ ] Build command installs Chromium for Playwright
- [ ] Start command is web server **not** `electron .`
- [ ] Set env vars on existing Profile-Updater service (or recreate)
- [ ] Redeploy; verify health + one Connect/Run smoke
- [ ] Update README: local Electron vs web deploy; ToS/open-URL warning

### Task 10: Verification

- [ ] `npm test` passes
- [ ] Manual: two browser profiles (different sid) isolated
- [ ] Manual: schedule fires after cron (or forced tick)
- [ ] Confirm Electron `npm start` still works locally if kept

---

## Risk notes

- Free RAM: one browser only; Connect snapshots at low rate.
- Service role key only on Render — never ship to client.
- Open URL abuse: acceptable for trusted friends; rotate `CRON_SECRET` if leaked.

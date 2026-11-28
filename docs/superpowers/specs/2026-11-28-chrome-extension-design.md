# Naukri Profile Updater — Chrome extension

**Date:** 2026-11-28  
**Status:** Approved in chat, pending spec review

## 1. Goal

Same Naukri update as the desktop app, as a personal Chrome extension. Install it on any laptop. This PC does not stay on. Nothing is stored online.

Each Chrome profile keeps its own Naukri login, settings, and resume PDF. On a new laptop: load the extension, sign into Naukri in that Chrome once, pick the PDF once.

Daily times run while that Chrome is open. If Chrome was closed, one missed update runs when Chrome next opens that same day.

## 2. Out of scope

- Chrome Web Store publishing. Install with Load unpacked.
- Syncing settings or the PDF across laptops.
- A server, Render, or Supabase path for this feature.
- Changing desktop or website behavior, except moving pure filename, bump, and slot helpers into a shared folder both the desktop app and the extension use.
- Hidden or headless runs. The Naukri tab stays visible.
- The desktop "Show Chrome while running" checkbox. The tab is always shown.

## 3. What the user can do

Parity with the desktop screen:

- See whether this Chrome is signed into Naukri. **Connect** opens the profile tab. If Naukri shows login, the status stays "Sign in on the Naukri tab". If the profile loads, status is "Connected in this Chrome". No password is stored.
- Choose trailing dots or custom text. Custom text is a separate box for Resume headline and Profile summary. Same append rules as today (strip trailing dots, then append; do not replace the whole field).
- Pick one PDF. Each run uploads a copy named `FirstName_LastName_Role_Resume_DD-MM-YYYY.pdf`. Blank name or role fields are filled from the original file name. The date is the laptop's local calendar day.
- Up to 4 daily times, plus enable toggle, plus "every 4 hours from the first time". Adding a time enables the schedule. A time added or edited after it has already passed today (including the current minute) does not run today.
- Settings auto-save. **Run now** starts an update immediately.
- Status log with clear log.

## 4. Architecture

```
Chrome on this laptop
  options page          form, auto-save, Run now, log
  service worker        alarms, single run lock, catch-up on startup
  Naukri tab            headline, summary, resume upload
        │
        └── chrome.storage.local  settings, log, fired slots
            IndexedDB             resume PDF bytes
```

Files live in `Profile-Updater/extension/`. Desktop Electron and the website stay as they are.

Shared pure functions (no Node `fs` or `path`) move to `Profile-Updater/shared/`:

- bump text (`nextHeadline`, `applyBump`, `uploadedToday`)
- slot normalize, "already passed today" keys, next-slot display
- filename helpers (`sanitizePart`, `identityFromResumePath`, `resolveIdentity`, `buildResumeFileName`)
- new `catchUpPlan` used only by the extension

Electron `prepareResumeCopy` stays in the desktop runner and calls the shared filename helper. Existing node tests import the shared modules. `npm test` must still pass.

The extension cannot run Playwright. The tab script repeats the desktop steps with the same page targets:

| Step | Target |
|------|--------|
| Profile check | path starts with `/mnjuser` |
| Headline edit | `#lazyResumeHead span.edit.icon`, `[data-ga-track*="resumeHeadline"] .edit` |
| Headline field | `#resumeHeadlineTxt` |
| Summary edit | `#lazyProfileSummary span.edit.icon`, `[aria-label="Edit profile summary"]` |
| Summary field | `#profileSummaryTxt` |
| Resume file input | `#attachCV`, `input[type="file"]` |
| Confirm upload | button whose text matches yes/upload, replace, or update |

Save still clicks the visible Save button and re-reads the field. A mismatch is a failed run. Upload still checks that the new file name or "Uploaded on" today appears on the profile.

## 5. Data on this Chrome only

`chrome.storage.local`:

| Key | Contents |
|-----|----------|
| settings | bump mode, both custom texts, first/last/role, schedule on/off, up to 4 `HH:MM` slots, original PDF file name |
| firedKeys | `YYYY-MM-DD\|HH:MM` already handled today. Drop keys older than 14 days. |
| logTail | status text, capped at 20 KB |
| lastResult | last run summary |
| connectedAt | set when a profile tab is confirmed, cleared when a run finds a login page |
| runningSince | timestamp while a run holds the lock, otherwise absent |

IndexedDB `resume` store holds one PDF (`bytes` plus `name`). Picking a new PDF replaces it. The options page refuses a file that is not a PDF or is over 6 MB, with the message "Choose a PDF under 6 MB".

Uninstalling the extension removes this data.

## 6. Schedule

One Chrome alarm per saved slot, repeating every 24 hours at that local time. Saving slots replaces the alarms. Turning the schedule off clears them.

While Chrome is open, an alarm runs that slot if it is not already in `firedKeys` for today.

On browser startup, `catchUpPlan` looks at slots that are enabled, not in `firedKeys`, and whose time is already past (or is the current minute), excluding slots pre-marked by the "added after it passed" rule:

- If none, do nothing.
- If one or more, run only the latest. When that run actually starts, mark the earlier missed slots fired for today without running them. If the run never starts (for example the login page), mark nothing. Opening Chrome then edits the profile at most once.

A second start while `runningSince` is under 10 minutes does not start another run. A lock older than 10 minutes is treated as a crashed run and may be taken.

Chrome may deliver a late alarm. A slot is due when local time is at or after that slot and it is not fired today. The run does not require the clock minute to match exactly.

## 7. Run flow

1. Options page or the alarm asks the service worker to start.
2. Worker refuses when the lock is fresh, when no PDF is stored, or when custom mode has an empty headline or summary box. The log says which check failed. **Run now** is disabled when there is no PDF.
3. Worker sets `runningSince`, opens `https://www.naukri.com/mnjuser/profile` in a normal foreground tab (reuse an existing profile tab in this window if one is open), and waits until it finishes loading.
4. If the tab is not on `/mnjuser`, clear `connectedAt`, release the lock, and log "Sign in to Naukri in this Chrome". Do not mark any slot fired. The next alarm, or the next time Chrome starts, can try once more. It does not retry in a loop.
5. The tab script asks the worker for settings and PDF bytes, builds a `File` with `buildResumeFileName`, then updates headline, summary, and resume in that order. A failed headline or summary stops the run before upload. For a catch-up, the worker marks the earlier missed slots fired now, before the page is edited.
6. The script sends each log line and the final ok/error to the worker. The worker appends the log, sets `lastResult`, marks that slot fired on success only, clears the lock, and leaves the tab open.
7. A scheduled run also shows a Chrome notification with the result. **Run now** only updates the log on the options page.
8. If the tab closes mid-run, the worker logs "Run interrupted" and clears the lock. The slot is not marked fired.

React text fields are set the same way as the desktop runner: set the textarea value and dispatch `input` and `change`. The file input is filled with a `DataTransfer` that holds the renamed `File`, then `change` is dispatched.

## 8. Errors

| Situation | What the user sees |
|-----------|--------------------|
| No PDF | Run now disabled. Schedule start logs "Choose a resume PDF before updating." |
| PDF over 6 MB or not a PDF | Rejected at pick time |
| Custom text empty | Run refused, same message as desktop |
| Naukri login page | "Sign in to Naukri in this Chrome" |
| Naukri word-count or save mismatch | The page error text, or "field did not save" |
| Upload not visible afterward | "cv upload did not stick" plus the Uploaded-on line if present |
| Already running | "A run is already in progress." |
| Tab closed | "Run interrupted" |

A failed attempt does not mark the slot that was attempted, so a later alarm or the next time Chrome opens can try it once more the same day. Earlier missed slots already marked when a catch-up run started stay marked. Nothing retries every minute.

## 9. Install

The extension is Manifest V3. Permissions: `storage`, `alarms`, `tabs`, `scripting`, `notifications`, and host access to `https://www.naukri.com/*`.

On each laptop: Chrome → Extensions → Developer mode → Load unpacked → the `extension` folder. Reloading the extension after an update keeps storage and the PDF.

## 10. Testing

- `npm test` covers shared bump, filename, slot, and `catchUpPlan` behavior. No browser required for those.
- Manual check after the extension loads: signed-in Chrome, pick a small PDF, **Run now**, confirm the headline dot changes and the uploaded name uses today's date.
- Manual schedule check: one slot two minutes ahead, Chrome left open, one run and one notification.
- Manual catch-up check: a slot set to a time already past today is skipped; with Chrome restarted after a slot time that was not pre-marked, one run happens.

Automating Naukri may conflict with Naukri's terms. The options page shows that in one line, same warning as the desktop app.

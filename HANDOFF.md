# Handoff — Naukari Profile Updater

Continue implementation **in this folder** (`d:\New folder\naukari-profile-updater`), not inside `d:\New folder\naukari`.

Reference automation (read-only): `d:\New folder\naukari\naukri_update\naukri-headline-dot.js` and `naukri-helpers.js`.

## Decisions (locked)

- Electron + plain HTML/CSS/JS (no React)
- Session login only (open Chrome → user signs into Naukri; no password storage)
- Each run: dot-cycle headline + profile summary, then rename/copy resume and re-upload
- Resume name: `FirstName_LastName_Role_Resume_YYYY-MM-DD.pdf`
- Up to 4 daily time slots; in-process scheduler (app must stay open)
- Settings in Electron `userData` JSON (no DB yet)

## Already done

| Path | Status |
|------|--------|
| `package.json` | Done — electron + playwright-core |
| `.gitignore` | Done |
| `electron/naukri-helpers.js` | Done |
| `electron/resume-name.js` | Done |
| `electron/scheduler.js` | Done |
| `electron/store.js` | Done |
| `electron/naukri-runner.js` | Done — connect + bump + upload |
| `electron/main.js` | Done — IPC + scheduler tick |
| `electron/preload.js` | Done |
| `ui/index.html` | Done |
| `ui/styles.css` | Done |
| `ui/renderer.js` | **MISSING** — write was cancelled |
| `test/*.test.js` | **MISSING** |
| `README.md` | **MISSING** |
| `npm install` | **NOT RUN** |

## Remaining steps (do these in order)

1. **Write `ui/renderer.js`** — wire form fields to `window.api` (getState, saveSettings, pickResume, connectAccount, runNow, previewResumeName, onStatus). Cap slots at 4. Match IDs in `ui/index.html`.
2. **Add unit tests** under `test/` for `resume-name.js`, `naukri-helpers.js`, and `scheduler.js` (`normalizeSlots`, `slotsDueNow`). Script: `"test": "node --test test/*.test.js"`.
3. **Write `README.md`** — `npm install`, `npm start`, Connect → fill name/role → pick PDF → Save → Run now; note app must stay open for schedule.
4. **Run `npm install`** then `npm test`.
5. **Smoke-check** `npm start` (window opens; Connect opens Chrome).

## Prompt to paste in the new Cursor chat

```
Finish the Naukari Profile Updater per HANDOFF.md in this repo.
1. Create ui/renderer.js (wired to preload APIs and index.html IDs).
2. Add test/*.test.js for resume-name, naukri-helpers, scheduler.
3. Add README.md with npm install / npm start / usage.
4. Run npm install and npm test; fix failures.
Do not change the locked decisions. Keep the solution small (ponytail).
```

## How to open this project in Cursor

1. File → Open Folder → `d:\New folder\naukari-profile-updater`
2. Start a new Agent chat in that workspace
3. Paste the prompt above (or say “continue from HANDOFF.md”)

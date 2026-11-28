# Naukri Profile Updater — Chrome Extension: Implementation & Hardening Spec

**Date:** 28 November 2026  
**Purpose:** Cursor-ready implementation brief and acceptance checklist  
**Status:** Proposed consolidated revision of the approved extension plan; implementation and live QA pending  
**Target:** Personal, local-only Chrome Manifest V3 extension inside the existing `Profile-Updater` repository

## 0. Instructions to Cursor

Implement this specification end to end, not merely as a code review. First inspect the existing repository, desktop runner, UI, shared utilities, test setup, and any extension work already present. Reuse working code and conventions wherever possible. The original approved plan remains the baseline; this document supersedes it where it explicitly resolves ambiguities or adds requirements.

- Preserve desktop Electron and website behavior. Do not rewrite unrelated code or introduce a backend. Extract only pure helpers necessary for reuse; preserve their existing contracts and desktop tests.
- Implement all **P0** and **P1** requirements below. P2 items are explicitly deferred. The goal is one complete development pass, including regression tests, build instructions, documentation and an implementation report.
- Make reasonable implementation choices within these constraints. Do not invent Naukri selectors, API contracts, account identifiers, or successful test results. If a live-site dependency cannot be verified, implement a fail-closed path, document the limitation, and mark the relevant manual check pending.
- Do not delete user data, overwrite unrelated local changes, commit secrets/resumes, deploy anything, or publish to the Chrome Web Store.
- Do not bypass CAPTCHAs, access restrictions, login, anti-automation controls or rate limits. Do not use hidden tabs, browser fingerprint manipulation, private Naukri APIs or stealth tooling. Verify Naukri's applicable terms before enabling automated runs; if the terms prohibit them, leave automated runs disabled and retain only compliant user-initiated functionality.
- Finish with the actual commands run, pass/fail counts, files changed, build output path, limitations and any manual checks still required. Never claim tests were executed if they were not.

Priority legend: **P0** = essential reliability/safety; **P1** = required usability for this release; **P2** = future enhancement, not required to ship.

## 1. Product scope and non-negotiable constraints [P0]

The user installs the extension on any laptop, signs into Naukri in that Chrome profile, selects a resume PDF once and configures updates. It works while that Chrome profile is running and the device is awake/online. If eligible updates were missed, at most one catch-up is attempted on the same local calendar day on startup or wake-up. Chrome alarms are best-effort, not guaranteed exact-time scheduling.

- Personal Chrome extension installed through **Load unpacked**; no Web Store publishing.
- No server, Render, Supabase, external telemetry, cloud storage, account syncing, native messaging, or Electron dependency at runtime.
- Settings, schedule, logs, and resume copy remain local to each Chrome profile. Profile edits and resume uploads are submitted directly to Naukri; Naukri itself stores the profile/resume online. Do not promise local data is encrypted by the extension or protected from someone who can access the computer.
- No password, OTP, cookies, authentication tokens or credentials collected, copied or stored by the extension. Use the existing normal Chrome login session only.
- Visible, normal foreground Naukri tab for all profile operations; leave it open after completion. No headless or background-tab editing. If the user switches away, pause before the next mutation and allow safe user-controlled resume or cancellation; do not repeatedly steal focus.
- Each browser profile/laptop is independent. If the same Naukri account is active on two laptops, duplicate or overlapping updates are possible. Recommend enabling automation on only one laptop at a time; do not add a backend to coordinate them.
- No changes to the current desktop `Show Chrome while running` feature. The extension has no such toggle.
- No claim or guarantee that profile changes improve recruiter visibility, ranking or hiring outcomes.
- Schedule defaults OFF on a new installation. Display the terms warning before first enabling scheduled updates. User acknowledgment is not permission from Naukri; automation must remain within the site's rules.

## 2. Repository and build architecture [P0]

Use the existing package manager and coding style. Suggested logical layout (adapt actual desktop/website paths after inspection, do not move them merely to match this example):

```text
Profile-Updater/
  [existing desktop and website sources unchanged]
  shared/
    bump.js
    filename.js
    slots.js
    catchUp.js
  extension/                 # extension source
    manifest.json
    background.js            # MV3 service worker entry
    scheduler.js
    runCoordinator.js
    storage.js
    resumeStore.js
    messages.js
    content.js               # top-frame DOM runner
    selectors.js
    options.html
    options.js
    options.css
    popup.html
    popup.js
    popup.css
    icons/
  dist/extension/            # self-contained, installable extension build
  [existing tests + extension tests/fixtures]
  package.json
```

### 2.1 Shared code

Move/reuse only pure helpers: `nextHeadline`, `applyBump`, `uploadedToday`, slot normalization, local-day keys, already-passed slot keys, next-slot display, `sanitizePart`, `identityFromResumePath`, `resolveIdentity`, `buildResumeFileName`, and extension-only `catchUpPlan`. Pure modules must not use Node `fs`, `path`, Electron, Playwright, Chrome globals or DOM. Pass dates/clocks and other dependencies explicitly to make tests deterministic. Support both Windows and POSIX original filenames where applicable. Keep Electron `prepareResumeCopy` and all actual filesystem operations in the desktop runner.

The extension cannot import files outside its installed root. Add `npm run build:extension` (or equivalent exposed via npm) to bundle/copy all required dependencies into `dist/extension/`. Use existing build tooling if practical; otherwise use a minimal local bundler. Produce local scripts, CSS, HTML and icons only. No remotely hosted JS, `eval`, inline event handlers or runtime CDN dependencies. Use a classic bundled content script or an explicitly supported MV3 loading pattern; do not assume content scripts support arbitrary ES module imports.

Keep the extension's installed root path stable and preserve extension ID when updating. Document that changing the path/ID or uninstalling may lose local data. Do not remove/re-add the extension to update it; rebuild in place and use Reload. Generated output must not contain resume files, credentials, logs, source maps with secrets, desktop binaries or unnecessary dependencies.

### 2.2 Manifest and compatibility

- `manifest_version: 3`, `background.service_worker`, `action.default_popup`, `options_ui` (or `options_page`), local icons.
- Minimum Chrome version **148** for structured clone support; set `minimum_chrome_version: "148"` and `message_serialization: "structured_clone"`. Use `chrome.*` APIs consistently. Confirm the actual build loads on the documented minimum. If a lower-version requirement emerges, explicitly switch to a tested JSON/base64 transport and document it rather than silently relying on unsupported binary messaging.
- Permission baseline: `storage`, `alarms`, `scripting`, `notifications`; include `tabs` only if actual tab operations need it beyond host permissions. Host permission limited to `https://www.naukri.com/*`. No broad host access, `cookies`, `debugger`, `webRequest`, `downloads`, `unlimitedStorage`, or `externally_connectable` unless a new justified requirement is approved.
- Disable incognito use (`incognito: "not_allowed"`). Use a restrictive MV3 extension-page CSP. No externally exposed resume resources.
- Inject only on verified Naukri profile tabs, in the top frame, for connection checks or an active run. Prefer programmatic injection with a single registered listener/runner per document. Do not start editing just because a profile page was opened normally.

## 3. Settings, local data, and migration [P0]

The service worker is the single writer/coordinator for run state, scheduling state, and settings commits. Extension pages send validated requests; content scripts receive only the data needed for the active run. Set `chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })` during initialization before handling sensitive requests. Never use `chrome.storage.sync` or the site's `localStorage`.

### 3.1 Logical storage schema

Adapt existing keys if an extension already exists. Use a schema version and idempotent migrations; do not reset saved settings/resume on upgrade.

| Key | Contents / rules |
|---|---|
| `schemaVersion` | Integer; migration tracked and tested |
| `settings` | Bump mode, separate custom headline/summary text, selected actions, first/last/role, original PDF metadata, schedule enabled/mode, custom slots, interval anchor, revision, pause day, terms acknowledgement |
| `resumeMeta` | Original basename, size, MIME, revision, selected timestamp; no local filesystem path |
| `connection` | Status, last verified timestamp, locally stored minimal account reference if reliably obtainable, rebind-required flag |
| `slotRecords` | Day+slot keyed state, attempts, reason, run ID, timestamps, outcome. Keep 14 local calendar days. Replace `firedKeys` as source of truth; migrate old fired keys as handled. |
| `activeRun` | Run ID, tab/window/document binding, trigger, slot key, settings/resume revisions, start day/time, stage, lease, cancellation flag, current step and step states |
| `pendingJournal` | Minimal before/target information for unfinished field writes, resume identity/revision and upload state; retain only while needed for same-day recovery or explicit review |
| `suffixState` | Per-account, per-field extension-owned custom suffix and minimal verification metadata; never remove arbitrary user-written content |
| `history` | Latest 50 finalized run/attempt records, redacted and size-bounded |
| `logTail` | Optional diagnostic log, latest 20 KiB (UTF-8), redacted |
| `lastResult` | Last attempt outcome, last successful update timestamp, safe error code/summary |

Use `storage.local` for JSON metadata. Use extension-origin IndexedDB for the PDF `Blob`/bytes, name, size, MIME and revision. Keep one current resume; retain a previous revision only transiently if necessary for atomic replacement, then remove it. Do not duplicate PDF bytes into storage.local or logs. Set a reasonable total history byte limit (e.g. 128 KiB), bound all strings and validate types. Do not silently swallow write/quota errors.

### 3.2 Resume selection and data consistency

- Accept only a non-empty PDF of at most **6,000,000 bytes** (6 MB decimal; explicit choice to remove ambiguity). Check `.pdf`, a plausible `%PDF-` header near the start, and MIME if present (allow empty/generic MIME if the signature and extension are valid). This is format screening, not full malware/validity verification. Reject known invalid/corrupt data if detected; never upload unvalidated input.
- Show the exact message `Choose a PDF under 6 MB` for rejected file selection, with a more specific explanation where possible. Keep the previously valid file if the new selection is rejected or a write fails.
- Replace the current PDF atomically in IndexedDB; treat that store as the authority for existence/revision. Commit matching metadata after success and reconcile metadata on startup if a crash occurred between writes. Detect missing/corrupt records and block upload until the user selects a valid PDF again.
- Snapshot the PDF revision at run start. Prevent replacement/removal during an active run or reject conflicting revisions before any edit. Never accidentally upload a newer/older file than the run selected.
- Offer Replace, Remove (with confirmation), and clear/reset all local extension data. Reset disables scheduling, clears owned alarms and local state/IndexedDB, and requires a fresh connection; refuse while a run is active unless safely cancelled first. Reset does not log the user out of Naukri, delete the original local PDF or undo profile changes.
- Uninstall removes the extension's own storage. Do not imply that it deletes data already submitted to Naukri or other OS-level copies.

### 3.3 Settings commits

Auto-save valid form edits (debounced). Show Saving/Saved/Error. Flush pending valid edits before Run now or connection-dependent operations. Use revision checks or a serialized worker queue so concurrent popup/options edits cannot overwrite newer state. Invalid fields must not silently replace a previously valid saved schedule; display an error and disable Run now/enable as appropriate. Persist incomplete custom fields as drafts if useful, but never schedule an invalid configuration. Reconcile alarms only on schedule-affecting changes, not every text keystroke.

## 4. Scheduling contract [P0]

### 4.1 Schedule modes

Two mutually exclusive modes:

1. **Custom times:** 1–4 distinct local `HH:MM` values, minute precision, normalized and sorted. Reject invalid/duplicate values. Adding a valid time enables scheduling only if the terms gate and required configuration checks pass; otherwise save the time with scheduling off and explain why.
2. **Every 4 hours from first time:** generate `anchor + 0h, +4h, +8h, +12h`, capped at four occurrences and stopping before local midnight. Do not wrap to next day. For 09:00 -> 09:00, 13:00, 17:00, 21:00; for 15:00 -> 15:00, 19:00, 23:00. Display the effective slots before saving. Retain separate mode inputs when switching.

Enable/disable toggle applies to either mode. Removing the final slot disables the schedule. The effective time zone is the laptop's current local zone, not a fixed UTC/IST offset. Display it. Use local date components rather than `toISOString().slice(0,10)` for keys or filenames. Key format: `YYYY-MM-DD|HH:MM`.

### 4.2 One-time alarms, not 24-hour repeat alarms

Chrome alarms do not wake sleeping machines. Delayed repeating alarms can drift after wake-up. Use one-time alarms for local calendar occurrences and recalculate after each scheduling event. A single next-occurrence alarm is preferred; one per slot is acceptable only if coalescing and stale alarms are handled identically. Namespace names (e.g. `npu:slot:*`, `npu:watchdog`, `npu:reconcile`); never clear another feature's alarms.

- Register `onAlarm`, `runtime.onStartup`, `runtime.onInstalled`, messaging, tab removal/navigation listeners synchronously at service worker top level. Await a shared initialization/migration barrier inside handlers. On worker activation, verify expected alarms exist; do not interpret every worker wake as browser startup or a new catch-up opportunity.
- On startup, install/update, schedule change, relevant alarm delivery, run finalization and time-zone/clock reconciliation, reconstruct upcoming alarms from persistent state. Use absolute `when` calculated from local calendar components; do not use service-worker `setInterval` as the scheduler.
- Store alarm schedule revision, intended slot/day and time-zone signature; reject stale alarms after config changes. Always compare against current authoritative settings before editing.
- Use a low-frequency reconciliation alarm (e.g. every 15 minutes) while enabled to detect zone/offset, clock discontinuities and missing alarms. This is maintenance, **not** a periodic retry mechanism. Recompute upcoming alarm times; only dispatch a missed run when there is a genuine newly due slot or documented wake/clock-jump event. No attempts every minute. Timezone changes are best-effort detected; do not promise instant reaction.
- On forward clock jumps / DST nonexistent local times, treat skipped slots as missed; coalesce to one eligible latest same-day slot. On backward clock jumps / repeated DST times, never fire a handled local day+time twice. Use calendar-day arithmetic rather than adding 86,400,000 ms. Test using a clock adapter and DST-capable timezone.
- Disable clears owned future slot/reconcile alarms; keep a watchdog only if needed for a current run. A paused schedule behaves similarly until the next local day (retain a next-day resume alarm).

### 4.3 Already-passed rules

When a slot is added, changed, regenerated by a mode change, or made newly eligible by enabling the schedule, mark that effective slot as `skipped_past_on_config` for today if its local time is <= current local minute. Example: at 14:30:20, adding 14:30 skips today. Unchanged existing slots keep their existing records. Disabling/re-enabling or deleting/re-adding a time must not clear a previously handled slot's record. Tomorrow's slots are unaffected. Changing unrelated settings must not suppress existing due slots.

### 4.4 Catch-up and late alarms

A pure `catchUpPlan({now, effectiveSlots, enabled, records, ...})` returns the latest eligible due slot and earlier eligible missed slots without mutating input. Eligible means same local day, configured and enabled, time <= current minute, not handled/suppressed, and within the retry budget. Never process a prior day's slot. Resolve overlapping alarm/startup events with one coordinator/lock.

On browser startup or a late alarm after sleep, evaluate all today's due slots, choose the latest eligible slot, and attempt at most one update. Only after configuration, authentication, account, visible-tab and page readiness checks pass, and an active run is durably committed immediately before the first edit, mark the earlier missed slots `skipped_coalesced`. If the selected run never starts editing, do not mark earlier missed slots handled. If it starts and later fails, earlier coalesced slots stay handled. For a run that crosses midnight, keep its original slot day; never start a prior-day retry.

A slot arriving while another run is active is not dispatched concurrently. Record it as pending/due if needed, schedule the next future alarm and coalesce after completion only if it is still a valid same-day due opportunity. Do not launch another identical update immediately after a successful overlapping run: mark a slot as `skipped_overlap` when the already-running successful update covered the same configuration and account; otherwise defer until a subsequent eligible trigger. Document this explicitly in the history.

### 4.5 Slot states and retries

Use explicit states: `pending`, `running`, `success`, `failed_retryable`, `failed_final`, `blocked`, `unverified`, `skipped_past_on_config`, `skipped_coalesced`, `skipped_overlap`, `skipped_paused`, `skipped_cooldown`. Handled states are success and the explicit skipped/final states. An uncertain upload is not automatically considered success or blindly retried.

- A slot gets at most **two actual mutation attempts**: initial + one automatic retry, only on a subsequent legitimate same-day startup or scheduled opportunity. No dedicated recurring retry alarm. Increment the attempt count durably immediately before the first mutation. Repeated restarts cannot cause unlimited writes.
- Preflight failures (no PDF, invalid settings, login required, account mismatch) do not mark slots fired or consume a mutation attempt. Record blocked reason; deduplicate repeated logs. Wait for user correction or a later legitimate trigger; do not automatically open a loop of tabs. Network/preflight checks may be capped per trigger; no immediate retry storm.
- For an interrupted or partial write, resume the same journal only if it can be verified and config/account/revision match. Do not start an unrelated automatic mutation that could overwrite an unresolved journal; require user review if ambiguity persists.
- A new due slot may supersede an earlier retryable slot through normal catch-up coalescing, provided no unresolved mutation journal exists. Do not run multiple missed slots back to back.
- CAPTCHA, security challenge, 429/rate limiting, access denial or uncertain account identity: suspend automatic runs, show Action required, require manual resolution and explicit resume. Never solve/bypass or automatically retry these conditions.
- `Run now` is user-initiated; it does not consume a scheduled slot by default. Explicit `Retry failed update` resumes the recorded failed operation when safe rather than creating another mutation. Manual Run now still respects lock, validation, account, compliance and unresolved-journal checks.
- Optional cooldown for a manual success shortly before a scheduled slot: default OFF to preserve existing parity; if implemented, use an explicit documented user-controlled threshold, e.g. 10 minutes, and mark skipped only if the same account/actions/settings/resume were successfully updated. Do not silently skip scheduled slots.
- Turning off scheduling during a run allows the current run to finish safely; cancels future automation. Pause today suppresses remaining slots for that local day, resumes tomorrow without catch-up of paused slots. Do not treat a cancellation or failure as success.

## 5. Service worker lifecycle and run coordination [P0]

Manifest V3 service workers may be terminated after inactivity. The run cannot rely on global memory, an open message port or a single long-running service-worker promise. Use an event-driven coordinator and durable checkpoints.

### 5.1 Lock and lease

Serialize all start/finish/recovery operations through one worker queue/mutex. The worker is the sole writer of the run lock; acquire it by reading current persisted state and writing the new run in the same serialized operation before any tab action. Do not use storage read-then-write independently from two handlers. Use a UUID `runId`, trigger (`manual`, `scheduled`, `catch_up`, `retry`), slot key if applicable, config revision, target tab/window/document binding, start time, heartbeat time and step status.

A new start with a fresh active run returns `A run is already in progress.` Heartbeats/progress are tied to the current run ID and document. Use an alarm-backed watchdog, not only timers. Suggested constants: heartbeat every 15–30 seconds during an active tab run; bounded per-stage waits; stale lease after 10 minutes; bounded total run duration of 10 minutes. Tune explicit step timeouts (e.g. profile readiness 45s, edit/save 30s, upload 90s) without increasing retries. A heartbeat is liveness, not permission to edit indefinitely.

A stale lock is not automatically proof the old script stopped. Revoke its authorization and verify the old runner is inactive before allowing another mutation. On every side-effect boundary the content script must obtain current run authorization; abort on revocation or missing response. If a previously dispatched upload/save could still complete, enter recovery/unverified status rather than starting duplicate edits. Never let an old final message release a newer run's lock.

### 5.2 Run sequence

1. Receive trigger, validate settings, selected actions and PDF when required. Check terms gate and pending journal, acquire persisted lock.
2. Reuse an existing verified Naukri profile tab in the chosen normal window (manual: requesting window where possible; schedule: last focused normal window), or open `https://www.naukri.com/mnjuser/profile`. If no normal window exists, do not start a hidden run; defer to next eligible opportunity. Bring the selected tab/window to foreground once. Do not navigate unrelated tabs or create duplicate profile tabs unnecessarily.
3. Wait for a valid top-frame document and bounded page readiness. Validate exact HTTPS host, expected profile route, logged-in markers and identity. Detect login, redirect, network errors and challenges. Bind the run to `tabId`, `documentId`/frame where available, and account.
4. Content runner reports readiness; worker snapshots settings and checks resume availability/revision. Persist intended run/slot state before issuing mutation permission. Coalesce earlier missed slots only at actual start as defined above.
5. Execute selected actions in fixed order: headline, summary, resume. Stop after the first failed or uncertain step. Send step events/checkpoints to worker and wait for acknowledgment of each persisted intent before writing.
6. Verify each selected operation independently. Finish with `success` only if all selected steps succeeded, or mark `no_changes`/already-current explicitly when no actual mutation was needed. Distinguish successful checks from confirmed edits in history.
7. Worker validates final message, persists result/history/slot state, clears active lock and unnecessary journal, reconciles alarms and sends scheduled notification exactly once per finalized attempt (or best-effort dedupe after crash). Manual runs update UI/history without scheduled notification.
8. Leave Naukri tab open. If user closes it/navigates away, record `Run interrupted`, revoke authorization and release only the matching run after reconciliation. Preserve partial journal if a write was possible. Do not mark success.

### 5.3 Recovery

On worker reactivation read active state and reconcile with live tab/document. If the current content runner is active, reconnect/resume status tracking without repeating mutations. If absent, expired, changed account, or browser restarted, treat it as interrupted and inspect the journal before another attempt. A fresh stored lock with no live runner must not unnecessarily block the user for ten minutes when absence can be proven; nevertheless do not retry uncertain writes blindly. Finalization must be idempotent, using run ID and persisted outcome to avoid duplicate history or notifications.

## 6. Connection and account safety [P0]

- Connect is a read-only verification operation. Open/reuse the visible Naukri tab; if login is required, show `Sign in on the Naukri tab` and let the user sign in manually. After navigation or an explicit Check connection, verify profile readiness and report `Connected in this Chrome` with last verified time. Do not ask for or intercept login details.
- URL prefix `/mnjuser` alone is not evidence of a signed-in profile. Require `https://www.naukri.com`, expected profile route (allow verified equivalent routes), and expected profile UI/identity indicators. Do not read unrelated account data or use private APIs.
- States: `not_connected`, `awaiting_sign_in`, `connected_last_verified`, `session_expired`, `action_required`, `unable_to_verify`, `account_changed`. Do not present a stale `connectedAt` as a live guarantee. Recheck every run, distinguish network failure from expired session.
- Bind configuration/resume to a stable minimal account reference only if the visible UI exposes a reliable identifier. Store only what is needed locally, preferably an opaque hash of a stable identifier; names alone are not reliable. On account mismatch, block edits and require deliberate rebind/reconfirmation of resume and settings. Do not fabricate identifiers or hash a guessed value. If reliable account identity cannot be verified, do not silently permit unattended writes; disable automation and require explicit current-account confirmation for a user-initiated run, with the limitation documented.
- Disconnect clears connection binding and pauses schedule, but does not sign out of Naukri or delete resume unless requested. On login/challenge, do not mark a slot successful or handled merely because the page opened.

## 7. DOM update behavior and idempotency [P0]

Use the existing desktop runner and its tests as the reference for normal bump rules. The extension cannot use Playwright at runtime. Implement a bounded visible DOM adapter; do not call unofficial site endpoints. Centralize all selectors in one module, scope them to the relevant editor and verify they resolve uniquely. Baseline selectors from the approved plan (live validity is unverified):

| Element | Candidate selector |
|---|---|
| Headline edit | `#lazyResumeHead span.edit.icon`, `[data-ga-track*="resumeHeadline"] .edit` |
| Headline field | `#resumeHeadlineTxt` |
| Summary edit | `#lazyProfileSummary span.edit.icon`, `[aria-label="Edit profile summary"]` |
| Summary field | `#profileSummaryTxt` |
| Resume input | `#attachCV`, scoped `input[type="file"]` only if uniquely confirmed as resume control |
| Save/confirm | Visible enabled button scoped to the active editor/upload dialog; exact known label or verified upload/replace/update/yes semantics |

Use readiness/visibility checks, bounded MutationObserver or polling within the content script, and explicit timeout/error codes. Do not click a global first `Save`, `Yes` or file input. Fail closed on ambiguity, missing editor, unexpected dialog, navigation, or disabled field. Check the exact origin/account before each mutation. Avoid logging raw page text if it may include personal information.

### 7.1 Bump modes and field validation

- Dots mode: preserve the desktop's tested trailing-dot algorithm and its length/rotation behavior. Do not invent a different cycling rule. Preserve all other content.
- Custom mode: separate text for headline and profile summary. Strip trailing dots according to existing rules; append only the configured suffix. Never replace the whole field. Validate nonempty custom text only for enabled fields. Respect actual site limits/validation; if a field would exceed a verified limit, report failure before saving rather than silently truncating profile text.
- Prevent custom text accumulating across runs. Track the extension-owned suffix per field/account after verification. If the current field ends with that exact known suffix at its recorded boundary, remove only that suffix before applying the new mode/text. Preserve manual edits; do not strip arbitrary matching text elsewhere. If ownership is ambiguous (first run, external edits, changed account), leave unrelated text alone and require review rather than destructive guessing. If the current field already has the intended suffix, treat as no change rather than appending again; do not claim that a no-op refreshed Naukri.
- Use native textarea value setter and dispatch appropriate bubbling `input`/`change` events for React-controlled fields, following the desktop's validated approach. Verify actual field value before Save. Click only the relevant visible Save, wait for completion and re-read persisted display/editor value with narrowly defined normalization (e.g. known newline behavior). Mismatch or site validation error stops the run before further edits/upload.

### 7.2 Durable intent journal

Before every field mutation, persist the exact intended target and sufficient original state to safely distinguish before/after values. Prefer hashes for before-state comparisons where full text is unnecessary; store full target only as long as recovery requires it. Do not copy these values into history or diagnostics.

| Recovery observation | Action |
|---|---|
| Current persisted field equals intended target | Mark step verified/recovered; do not apply a new bump |
| Current field equals original before-state | Retry the same intended write if authorized and within budget |
| Current field differs from both | Conflict; stop and request review, never overwrite external changes |
| Previous step verified, later step failed | Re-verify completed steps; resume failed step only if still consistent |
| Config, account or resume revision changed | Do not reuse old intent automatically; require explicit review |
| Upload dispatched, fresh result unknown | Mark unverified; do not blindly upload again |

A journaled upload is an external side effect that cannot be made exactly-once solely with local state. Keep status honest; expose a user review path. Never roll back successful remote edits automatically. Purge sensitive journal data when terminal/reconciled; expire old retry eligibility at local midnight and do not carry unresolved writes into a new automatic run without review. A user can explicitly discard an unresolved journal after viewing its safe summary; this is not a rollback.

## 8. Resume naming, transport and upload verification [P0]

### 8.1 Filename

Generate a new browser `File` from stored PDF bytes, never alter the original file or rename anything on disk. Format: `FirstName_LastName_Role_Resume_DD-MM-YYYY.pdf`. Date = laptop local calendar date at actual run start; freeze for that attempt/recovery so midnight does not change the target. Trim/sanitize components, strip path separators/control characters, normalize spaces to underscores according to existing helpers, avoid empty components/reserved names/overlong output. Fill blank name/role inputs from the original basename using existing helper rules. If identity cannot be resolved reliably, display editable fields and block upload rather than fabricate a name or role. Preview the generated filename in settings.

### 8.2 Binary transport

With Chrome 148+ structured clone messaging, transfer a `Blob` or `File` through validated extension messaging; reconstruct with `new File([blob], filename, { type: 'application/pdf' })` in the authorized tab. Do not base64-log, expose as a web-accessible resource or send to unrelated contexts. Verify sender, active run ID, tab, top frame/document, step and PDF revision before releasing bytes. Transfer once per authorized upload step; test near maximum size. If transport fails, stop before mutation where possible and report failure rather than using an insecure fallback. Preflight transport readiness before headline/summary edits if upload is selected.

### 8.3 Upload and success evidence

Use the actual resume input, create a `DataTransfer`, add the renamed File, assign `input.files`, dispatch the expected bubbling `change` event, and handle only the known visible upload confirmation dialog. Journal intent before dispatch. Do not upload more than once per attempt. Do not bypass file restrictions or directly invoke undocumented upload endpoints.

`filename matches OR Uploaded on today` is insufficient evidence of a new upload: multiple runs on the same day share filename/date. Capture pre-upload state, require a fresh operation-specific success signal from the UI (e.g. newly observed confirmed upload success or a verified changed upload timestamp), then re-read the persisted resume display and check expected filename where the UI exposes it. An unchanged same-day label or old toast is not proof. If no fresh evidence is available, report `cv upload did not stick` / `Upload unverified`, include a safe Uploaded-on status if available, and do not mark slot success. Never retry an ambiguous dispatched upload without user review or reliable evidence that it did not take effect.

## 9. Messaging and security boundaries [P0]

Define an explicit typed/validated message contract. Suggested messages: `GET_STATE`, `SAVE_SETTINGS`, `CONNECT`, `DISCONNECT`, `RUN_NOW`, `RETRY_RUN`, `CANCEL_RUN`, `PICK_RESUME`, `REMOVE_RESUME`, `CLEAR_LOG`, `RESET_DATA`, `RUN_READY`, `REQUEST_STEP_AUTH`, `STEP_INTENT`, `GET_RESUME`, `STEP_RESULT`, `RUN_HEARTBEAT`, `RUN_FINISH`.

- UI commands only from trusted extension pages. Tab runner commands only from the extension's own active bound Naukri tab, exact HTTPS origin, top frame, expected document ID and matching run ID. Validate command, types, length, state transition and revision. Never trust a tab ID supplied in payload instead of `sender.tab.id`. Reject messages from stale runs or unrelated frames.
- Never expose secrets or full settings on a generic content-script request. Give only the current step's configuration/bytes. Do not add window.postMessage bridges or external messaging handlers. Render logs/settings with `textContent` or safe escaped templates, not raw `innerHTML` from page/user input.
- No network requests to third-party services. No external tracking. No profile data, email, phone, PDF contents, full field values, auth material or raw HTML in exported logs, console output, notifications or history. Show only sanitized bounded error details. Local PDF and journal are sensitive; advise using a trusted computer/Chrome profile.
- Use explicit safe error handling for rejected Chrome API calls, tab closures, IndexedDB failures and unavailable notifications. A notification failure must not turn a verified profile update into a failed run.

## 10. User interface and experience [P1]

Keep the existing desktop screen's familiar language and behavior where appropriate. Use a simple, responsive, accessible design with clear headings, keyboard navigation, labels, focus states, and status indicators that do not depend on color alone. No external fonts or libraries at runtime unless already locally bundled and justified.

### 10.1 Toolbar popup (quick overview)

Show:
- Extension name and version.
- Connection status and last verified time, plus Connect/Check connection action when needed.
- Schedule enabled/paused/off, local timezone, today's slots and their status, and next scheduled run date/time. Indicate that execution may be delayed by Chrome or device sleep.
- Last attempted update and last successful update separately; display a warning when the last result is partial, failed or unverified.
- Current progress, e.g. `2 of 3: Updating profile summary`.
- PDF selected/not selected, original basename and size, without exposing document content.
- Run now, Open settings, and View activity actions. Disable Run now while a run is active or the committed configuration is invalid; explain why. Popup closure must not cancel a run.

### 10.2 Full options page

Sections:

1. **Connection:** Connect, Check connection, Disconnect/Rebind, last verified status, manual login and account mismatch guidance.
2. **Update preferences:** Three independent toggles (headline, summary, resume), all ON by default to preserve desktop parity. At least one action required. Dots/custom mode, separate custom boxes for enabled text actions. Disable irrelevant inputs rather than silently discard them. Provide a concise explanation of append rules and that updates may not change recruiter visibility.
3. **Resume:** Pick/Replace/Remove, selected filename, size, name/role inputs, resolved identity and generated filename preview using today's local date. Require PDF only if resume upload is selected. Missing PDF must not block a text-only run. If invalid, show specific field guidance. Do not display PDF contents in the popup or log.
4. **Schedule:** Enable toggle, custom vs every-four-hours mode, up to four time inputs, duplicate validation, effective slots, local timezone, next occurrence, today status, pause for today / resume tomorrow, and a note that Chrome must be running. If paused today, explicit resume today makes only future slots eligible. Terms acknowledgment and one-laptop recommendation visible near activation. Do not enable silently if the configuration or policy gate is invalid.
5. **Run:** Run now, Retry failed update when recoverable, Review unresolved update when uncertain, Cancel active run. Cancellation takes effect at the next safe step boundary; already submitted writes may complete and must be reconciled. Never promise cancellation reverses completed edits.
6. **Activity:** Structured history, per-step outcomes, timestamps and error codes. Clear log/history confirmation. Clearing logs must not reset scheduling records, active locks or retry budgets. Show version and privacy/compliance note.
7. **Local data:** Reset all extension data with destructive confirmation; explain what stays on Naukri and on disk. Do not run reset during an active mutation.

Settings must auto-save, remain consistent between popup/options across reload, and display actionable validation errors. Show a running state from persisted worker data rather than a popup-local timer. A run can be cancelled even if the popup that started it closed. Render success only after the worker's verified final result. Provide accessible status updates without excessive notifications.

### 10.3 Notification behavior

One Chrome notification per finalized scheduled/catch-up attempt where permitted: `Profile update completed`, `Profile update failed`, `Profile update needs attention`, or `No changes needed`, with a short non-sensitive summary. Preflight blocked notifications should be deduplicated to avoid spam. Manual runs update UI/history only. Notification permission or OS notification failure does not change the actual run result. No promise of OS-level delivery while notifications are disabled or Do Not Disturb is active.

## 11. Activity, result and error contracts [P0/P1]

Structured run history is P0; user-facing history rendering is P1. Keep the latest 50 finalized attempts, also bounded by bytes. Example record (illustrative, not live data):

```json
{
  "runId": "uuid",
  "trigger": "catch_up",
  "slotKey": "2026-11-28|09:00",
  "startedAt": "2026-11-28T09:42:00+05:30",
  "finishedAt": "2026-11-28T09:42:21+05:30",
  "status": "failed_retryable",
  "steps": {"headline":"verified", "summary":"verified", "resume":"failed"},
  "errorCode": "UPLOAD_FAILED",
  "message": "Resume upload failed; previous steps verified."
}
```

Track stage states such as `not_selected`, `pending`, `in_progress`, `verified`, `no_change`, `failed`, `unverified`, `cancelled`. Track result states separately from slot states: `success`, `no_changes`, `failed_retryable`, `failed_final`, `blocked`, `interrupted`, `cancelled`, `unverified`, and `conflict`. A fully verified no-change run is a handled slot but not evidence of a profile mutation; keep last successful check and last confirmed mutation distinct. Store history and last result idempotently by run ID. Coalesced/skipped slots appear in today's schedule even if they have no run record.

### 11.1 Errors and required behavior

| Condition | User-facing text or meaning | Required behavior |
|---|---|---|
| No selected action | Select at least one update action. | Block start |
| Missing PDF when upload selected | Choose a resume PDF before updating. | Disable manual start; block schedule without consuming mutation attempt |
| Invalid PDF / too large | Choose a PDF under 6 MB | Reject replacement; retain last valid PDF |
| Custom text missing | Use existing desktop message for each enabled field | Block invalid run |
| Identity incomplete | Enter missing name/role before uploading. | Block upload run |
| Already active | A run is already in progress. | Reject competing start |
| Login required | Sign in to Naukri in this Chrome | Clear verified connection status; no mutation |
| Unknown/different account | Confirm the correct Naukri account. | Block unattended edits; deliberate rebind |
| Challenge/access restriction/429 | Action required — resolve on Naukri and resume manually. | Suspend automation; no bypass/retry loop |
| Network or page timeout | Could not load or verify Naukri profile. | Bound waits; distinguish from login |
| Missing/ambiguous selector | Profile layout could not be verified. | Stop without guessing |
| Word count/save validation | Sanitized site error or field did not save | Stop before later steps |
| External edit conflict | Profile changed outside this run; review before retrying. | Do not overwrite |
| Definite upload failure | Resume upload failed. | Preserve verified steps; bounded retry if safe |
| Ambiguous upload | cv upload did not stick / Upload unverified | No blind automatic upload; request review |
| Closed/navigated tab | Run interrupted | Revoke run; reconcile journal; no false success |
| User cancels | Run cancelled; completed changes may remain. | Stop at safe boundary; preserve partial state |
| PDF missing/corrupt on restart | Saved resume is unavailable. Please select it again. | Disable upload run |
| Local write/quota error | Could not save local extension data. | Fail closed before further mutation |
| Browser version unsupported | Update Chrome to version 148 or newer. | No unsupported messaging fallback |
| Chrome alarm delayed | Update delayed; next scheduled time recalculated. | Keep wall-clock schedule |

Keep error categories stable in code/tests. Do not turn every exception into a login error. Cap logs, truncate safely and escape display strings. Never log the actual resume or profile content. For an unresolved run, explain what was verified, what is uncertain, and which action the user can safely take.

## 12. Testing plan and acceptance criteria [P0]

Run `npm test` before and after changes. Preserve existing tests and add deterministic pure-unit tests, worker/storage integration tests with Chrome API mocks, and DOM fixture tests. Use an external Playwright/Chromium test harness if supported by the repo, not inside the installed extension. Do not run automatic mutation tests against a real account without explicit user authorization. Use local synthetic profile fixtures to test save/upload behavior. Do not include real resumes or account data in fixtures. If browser execution is unavailable in Cursor's environment, explicitly report this and keep those checks pending.

### 12.1 Shared helper / scheduling tests

| ID | Test | Expected result |
|---|---|---|
| S01 | Existing desktop bump and filename cases | All prior tests still pass |
| S02 | Invalid, duplicate, unsorted custom slots | Invalid rejected; valid distinct slots sorted |
| S03 | Four-hour anchor 09:00 / 15:00 / 23:59 | 4 / 3 / 1 slots, no next-day wrap |
| S04 | Add/edit at past minute or current minute | Skipped for today; available tomorrow |
| S05 | Edit unrelated text settings | Existing eligible slots unchanged |
| S06 | Disable/re-enable, remove/re-add handled slot | No duplicate same-day run; past newly eligible slots skipped |
| S07 | Startup before first slot | No catch-up; next slot armed |
| S08 | Startup after one missed slot | One eligible catch-up |
| S09 | Startup after multiple missed slots | Latest eligible only; earlier marked only after mutation starts |
| S10 | Closed for several days | No prior-day catch-up |
| S11 | Wake after multiple slots | Coalesce one latest same-day attempt; tomorrow's time stays correct |
| S12 | Late alarm after midnight | Do not execute the prior-day slot |
| S13 | Stale alarm after schedule edit | No outdated mutation; current schedule restored |
| S14 | DST forward gap, backward fold, timezone change | Reconcile calendar slots, no double firing, best-effort catch-up |
| S15 | Manual/system clock moves forward/backward | No repeated handled local slot; next alarm recalculated |
| S16 | Two alarms or alarm + manual start concurrently | Exactly one active run/authorized writer |
| S17 | Next slot due during active run | No overlap; consistent pending/skipped behavior |
| S18 | Retryable failure with repeated browser restarts | Maximum two mutation attempts per slot; no infinite loop |
| S19 | Login/no PDF blocked catch-up | No mutation attempt consumed; no earlier slots fired |
| S20 | Disable/pause during active run | Current run finishes or cancels safely; future alarms suppressed |
| S21 | Pause today then local day changes | Resume tomorrow, no catch-up of paused slots |
| S22 | Run starts before midnight, completes after | Original slot key and frozen filename date retained |
| S23 | Worker starts without persisted alarms | Reconstruct expected alarms without treating activation as browser startup |
| S24 | Old records | Prune by 14 local calendar days, not by fixed UTC-hour interval |
| S25 | Manual run and scheduled run policy | Manual does not mark scheduled slot by default; optional cooldown only when explicitly enabled |

### 12.2 Update and recovery tests

| ID | Test | Expected result |
|---|---|---|
| R01 | Dots mode, normal fields | Desktop parity; verify persisted values |
| R02 | Custom suffix repeated / changed / mode switched | No accumulation, only owned suffix removed; preserve base text |
| R03 | Ambiguous existing suffix / external manual edits | Safe conflict handling; no arbitrary deletion |
| R04 | Site word-count error or save mismatch | Stop before later steps/upload |
| R05 | Hidden/duplicate/unrelated save buttons or file inputs | Fail closed; do not click unrelated UI |
| R06 | Selected actions: each alone and combinations | Only selected actions; no PDF needed for text-only |
| R07 | No action selected or enabled custom field empty | Block start |
| R08 | Headline success then summary fails | Verified headline persisted; retry does not bump it again |
| R09 | Worker killed after Save before result recorded | Re-read exact intended value; recover without extra write |
| R10 | Worker killed before mutation | No false success, recover or safely retry |
| R11 | Live runner survives worker termination | Reattach tracking; no duplicate runner |
| R12 | Browser/extension restart with pending journal | Recover safe same-day intent or require review |
| R13 | Old runner sends progress/final after new run | Ignore stale message; current lock remains |
| R14 | Stale lock while old runner still active | Revoke, prove stop or mark uncertain before new mutation |
| R15 | Profile tab closed or navigated mid-run | Interrupted; authorization revoked; partial journal preserved |
| R16 | User switches away / cancels | Pause or cancel at safe boundary; no hidden edit |
| R17 | First upload succeeds; second same-day upload fails | Old filename/date cannot prove second success |
| R18 | Upload dispatched then browser closes | Unverified; no blind duplicate upload |
| R19 | Valid new upload confirmation and persisted name | Verified upload only with fresh evidence |
| R20 | Network timeout before vs after mutation | Correct retryable vs uncertain classification |
| R21 | Session expires mid-run / account changes | Stop, do not send PDF or further mutations |
| R22 | Security challenge, access denial or rate limit | Suspend scheduling and require manual resolution |
| R23 | Notification API failure | Verified update remains successful; safe diagnostic only |
| R24 | Finalization replay / duplicate finish | One history record per run; no duplicate logical completion |
| R25 | All selected actions already current | Accurate no-change result, not fabricated refresh |

### 12.3 Storage, security, UI and build tests

| ID | Test | Expected result |
|---|---|---|
| D01 | Valid PDF, zero bytes, disguised non-PDF, MIME blank, 6 MB boundary | Valid accepted; invalid rejected; limit exact |
| D02 | Invalid replacement / IndexedDB write failure | Previous PDF remains available |
| D03 | Crash between PDF write and metadata commit | Reconcile matching revision/metadata on startup |
| D04 | PDF changed during run | Prevent conflicting revision or safely abort |
| D05 | Chrome restart / extension reload | Settings, schedule, PDF and history survive |
| D06 | Two Chrome profiles | Data, login, locks and schedules independent |
| D07 | Schema migration incl. old firedKeys | Existing data retained; migration idempotent |
| D08 | Malformed messages, wrong tab/frame/document/run ID | Rejected; no PDF or mutation authorization leaked |
| D09 | Log strings contain HTML/PII or oversized content | Escaped, redacted and bounded |
| D10 | Clear logs | Schedule/lock/retry data unaffected |
| D11 | Reset or remove PDF | Correct local deletion; no remote deletion/logout |
| D12 | Filename spaces, path separators, unicode, missing identity, midnight | Safe and deterministic filename or actionable validation |
| D13 | Binary messaging with near-limit PDF | Correct File name, bytes and MIME; no corruption |
| D14 | Popup/options simultaneous edits | No stale overwrite; save state visible |
| D15 | Popup closes during run | Run continues; reopen shows correct progress |
| D16 | New install defaults / terms gate | No unattended edits before compliant opt-in |
| D17 | Wrong account / unavailable stable identifier | No unattended upload; deliberate confirmation required |
| D18 | Build from clean checkout | Self-contained dist/extension, no parent imports or secrets |
| D19 | Extension permissions and CSP | Minimal allowed permissions; incognito disabled; no remote JS |
| D20 | Desktop and website regression | Existing behavior unchanged; tests/builds pass where available |

## 13. Manual acceptance checklist [P0]

Use a normal, authorized test Chrome profile and a non-sensitive test PDF. Do not exercise real automated profile writes unless applicable Naukri terms allow them and the user has authorized the test. If live testing is not possible, leave the following checklist as pending, not passed.

- [ ] Build extension and load `dist/extension/` using Developer mode > Load unpacked; no manifest errors.
- [ ] Open popup and options; version, empty state, schedule OFF, warning and local-only explanation appear.
- [ ] Connect with signed-out Chrome; manually sign in; verify connection status and correct account.
- [ ] Select PDF, validate filename preview; reject an invalid/oversized file without losing previous valid selection.
- [ ] Run now once with all three actions; verify actual headline, summary and displayed resume evidence on Naukri; correct local date in filename.
- [ ] Test custom mode twice; no unintended suffix accumulation; no false claim that an unchanged field was refreshed.
- [ ] Run text-only without PDF; upload-only; verify independent actions.
- [ ] Schedule a time two minutes ahead (if permitted); keep Chrome open, observe one update and one notification; next slot time correct.
- [ ] Add a slot in the current/past minute; ensure no immediate scheduled update.
- [ ] Configure a future slot, fully quit Chrome before it, reopen later same day; verify exactly one catch-up.
- [ ] Miss multiple slots while Chrome is closed or laptop sleeps; verify coalescing and next-day wall-clock timing.
- [ ] Turn off schedule; verify no further scheduled runs; pause today/resume behavior.
- [ ] Close popup mid-run, reopen; verify progress. Simulate tab closure and worker termination using DevTools or mock tests; verify safe recovery.
- [ ] Test session expiration, account mismatch and a simulated challenge using safe fixtures where possible; ensure no automatic bypass.
- [ ] Confirm same-day ambiguous upload cannot be reported as success based only on filename/date.
- [ ] Reload extension in place; PDF/settings persist and no duplicate alarms are created.
- [ ] Confirm a second Chrome profile has independent data; verify no accidental cross-account upload.
- [ ] Clear log, remove test resume and reset test extension data; verify expected local-only effects.
- [ ] Review Chrome extension console for unhandled errors, warnings, sensitive data leakage and unexpected network requests.
- [ ] Run desktop regression tests and smoke-check existing desktop behavior; verify website unaffected.

## 14. Installation and maintenance documentation [P1]

Add an extension README (or clearly separated section of the existing README):

1. Requirements: supported Chrome 148+, personal authorized Naukri account and permission to perform intended operations under applicable terms.
2. Build from repository root using the actual package-manager commands, e.g. `npm ci`, `npm test`, `npm run build:extension` (only use `npm ci` when a lockfile supports it).
3. Open `chrome://extensions`, enable Developer mode, click Load unpacked and select `dist/extension/`.
4. Pin toolbar icon, open options, Connect and sign into Naukri manually, verify account, choose a valid PDF, configure actions and optionally enable schedule after policy check.
5. Explain local scheduling, device sleep, browser shutdown, same-day catch-up, maximum four slots, retry limit, local timezone and manual-only behavior when automation is not permitted or identity cannot be verified.
6. Update: rebuild at the same location, use Reload, check status; do not uninstall if retaining data matters. Do not move the installed root without understanding extension ID implications.
7. New laptop/profile: install independently, sign in, select PDF and configure settings; nothing syncs. Keep scheduling active on one laptop per account to minimize duplicate edits.
8. Troubleshooting: login expired, missing/corrupt resume, unknown account, blocked automation, selector/site change, no alarm during sleep, unverified upload, recoverable partial run, and local reset/uninstall consequences.
9. Privacy: local data is sensitive and not extension-encrypted; Naukri receives submitted changes directly. No server/analytics. Do not share the generated extension along with real resume or Chrome-profile data.

## 15. Explicit implementation decisions and deferred scope

These are proposed decisions that resolve ambiguities in the original plan; implement them consistently unless the repository proves a conflicting existing contract that must be preserved for desktop parity.

| Decision | Default for extension |
|---|---|
| Browser support | Chrome 148+ with structured clone |
| Install root | `dist/extension/` |
| Maximum PDF | 6,000,000 bytes; preserve desktop limit independently |
| Schedule model | One-time local-calendar alarms; max 4 effective slots |
| Catch-up | Latest eligible same-day slot only |
| Retry | One automatic retry after initial actual mutation attempt; no retry loop |
| Custom text | Idempotent, extension-owned suffix; no arbitrary removal |
| Update actions | All three enabled by default; independently selectable |
| Manual-run cooldown | OFF by default; optional user-controlled enhancement |
| Schedule on new install | OFF; compliant opt-in required |
| Account verification | Fail closed; no unattended write if identity cannot be reliably established |
| Unverified external mutation | Manual review, no blind replay |
| History | Latest 50 attempts, 20 KiB diagnostic tail, 14-day slot records |
| Local data | No sync or backend; reset with confirmation |

P2 (defer): export/import local settings, redacted log file export, optional manual-run cooldown controls, additional analytics dashboards, broader browser support, and Web Store publishing (the latter would require a new scope decision). Do not add a server or cross-device synchronization. Keep the release focused on reliable personal use.

## 16. Definition of done and Cursor handoff

Implement in this order, with tests alongside code:

1. Inspect repository and establish baseline tests; extract shared pure helpers without changing desktop behavior.
2. Set up extension build/manifest and local storage/migration/PDF handling.
3. Implement scheduling, persistent coordinator, run journal, message validation and recovery.
4. Implement connection checks, account safety, scoped DOM adapter and upload verification.
5. Build popup/options, validation, notifications, activity and reset controls.
6. Add automated tests/fixtures and run the regression suite, build the extension, document install and limitations.
7. Produce the final implementation report below. Mark unresolved live dependencies honestly. Do not certify real-site readiness until the live acceptance checks are performed.

Definition of done:

- [ ] All P0 and P1 items implemented, or explicitly listed as blocked with fail-closed behavior and rationale.
- [ ] Existing `npm test` passes and new test suite passes; no silently removed or weakened tests.
- [ ] `npm run build:extension` produces a loadable, standalone extension with no files imported outside its root.
- [ ] No duplicate scheduled mutations on mocked concurrent triggers or repeated worker startup.
- [ ] No automatic overwrite after uncertain write, account mismatch or external field conflict.
- [ ] No false upload success based on stale same-day filename/date.
- [ ] Settings and PDF survive reload/restart in tested browser environments.
- [ ] No backend, remote telemetry, credential storage, broad host permissions or hidden/headless runtime.
- [ ] Desktop and website remain unchanged except approved pure-helper extraction and related test/build wiring.
- [ ] README and manual acceptance checklist available.
- [ ] Actual live Naukri policy/selector/account-identity limitations clearly documented; automatic editing stays disabled if not verifiable/permitted.

Final report format:

```text
IMPLEMENTATION SUMMARY
- Main changes:
- Files added/modified:
- Build/install path:
- Decisions or deviations from spec and reasons:

VERIFICATION
- Baseline test command/result:
- Final test command/result (actual counts):
- Extension build command/result:
- Browser/fixture tests executed/result:
- Live manual checks executed/result:
- Desktop/website regression result:

REMAINING BLOCKERS / LIMITATIONS
- Pending manual checks:
- Naukri policy/selector/identity verification:
- Known edge cases or unimplemented P0/P1 items:
- Exact next action for the user, if any:
```

Do not respond with only a plan or another speculative review. Execute the code and tests available to you, then report verifiable outcomes. Do not run live account changes without user permission. No document can guarantee zero future issues because Naukri's DOM, policy and Chrome behavior can change; the design should fail safely rather than guess.

## 17. Technical references and verification notes

Official Chrome documentation checked on 28 November 2026:

- [Chrome alarms API — sleep, persistence and scheduling](https://developer.chrome.com/docs/extensions/reference/api/alarms)
- [Manifest V3 service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [Service worker migration — timers and persistent state](https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers)
- [Structured clone extension messaging — Chrome 148+ opt-in](https://developer.chrome.com/blog/structured-clone-messaging)
- [Chrome storage API — access levels and quotas](https://developer.chrome.com/docs/extensions/reference/api/storage)

Naukri's current terms and live DOM could not be verified during preparation of this brief (website access was blocked by robots.txt in the research environment). The selectors are supplied by the original plan, not independently validated. The repository and desktop code have not been inspected by the author of this document. Cursor must verify actual code contracts locally, use test fixtures, and clearly report pending live checks. Treat the proposed limits and UI decisions as explicit requirements for review, not as facts about the existing application.





Prompt --

Read @Naukri_Profile_Updater_Cursor_Spec.md completely and treat it as the consolidated implementation specification for the Chrome extension.

Inspect the existing repository and understand the current desktop application, website, shared logic and extension implementation before making changes.

Implement all P0 and P1 requirements mentioned in the document end to end. Do not limit your response to reviewing the specification or suggesting another implementation plan.

Make sure that:

- All existing desktop and website functionality remains intact.
- All scheduling, recovery, storage, security and error-handling edge cases are covered.
- The extension remains completely local, without any backend dependency.
- All required automated tests are implemented and executed.
- The extension is built successfully and ready for Load unpacked installation.
- No unrelated functionality is modified.
- No live Naukri account changes are performed without authorization.

Follow the implementation sequence, acceptance criteria and definition of done provided in the Markdown file.

Once complete, perform a comprehensive self-review against every requirement in the specification, fix any identified gaps, and provide the final implementation report, including actual test results and any remaining manual verification requirements.
# Naukri Profile Updater extension

Personal Chrome extension. It edits a Naukri profile only in a visible tab of this Chrome profile. There is no server, account sync, telemetry, or Electron process. The desktop app and website are separate and stay as they are.

Naukri's current terms and live page layout were not verified while this was built. Selectors come from the desktop runner and are treated as unverified. If a control is missing or ambiguous, the run stops. Scheduled automation stays off until you turn it on, and it stays blocked when the page does not expose a reliable account id.

## 1. Requirements

- Chrome 148 or newer. Older Chrome cannot load this extension (`minimum_chrome_version` is 148, and messages use structured clone).
- A normal Chrome profile where you can sign in to Naukri yourself.
- Your own decision that the profile changes you request are allowed by Naukri's terms. The checkbox in settings is your confirmation. It is not permission from Naukri.
- A PDF resume of at most 6,000,000 bytes, only if you turn on resume upload.

## 2. Build

From the repository root, with Node 22 or newer:

```bash
npm ci
npm test
npm run build:extension
```

`npm ci` needs the committed lockfile. The build writes only local HTML, CSS, JS, and icons to `dist/extension/`. It does not embed a resume, logs, or secrets.

## 3. Install

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Click Load unpacked.
4. Choose the `dist/extension/` folder.

Pin the toolbar icon. Open options. Use Connect and sign in on the Naukri tab. The extension never asks for your password, OTP, cookies, or tokens.

## 4. Configure

1. Choose the headline, summary, and resume actions you want. All three start on, matching the desktop app. Turn resume off if you only want text updates.
2. Pick a PDF if upload is on. Rejected files show `Choose a PDF under 6 MB` and keep the last valid file.
3. Fill any missing first name, last name, or role. The upload name is `FirstName_LastName_Role_Resume_DD-MM-YYYY.pdf`, using this laptop's local date when the run starts.
4. Leave the schedule off unless you have confirmed the terms allow it. Then pick up to four local times, or one start time for every four hours until midnight. The time zone shown is this laptop's current zone.

Run now is manual. It does not mark a scheduled slot as done. If the account id cannot be read from the page, check the confirmation box before Run now. That confirmation does not turn unattended runs on.

## 5. What the schedule actually does

- Chrome alarms are best-effort. They do not wake a sleeping computer, and they do not fire while Chrome is quit.
- Times are one-time local calendar alarms, then the next one is calculated again. There is no 24-hour repeating alarm.
- At most four slots a day. A new or edited time that is already past, including the current minute, is skipped today.
- If several of today's slots were missed, the extension attempts only the latest one. Earlier ones are marked skipped only after that attempt actually starts editing.
- Yesterday is never caught up.
- Each scheduled slot gets at most two real edit attempts: the first try and one later retry. Login problems and a missing PDF do not use up an attempt.
- A manual success does not skip the next slot. There is no cooldown control in this release.
- Pause today skips the rest of today. Tomorrow starts on the normal clock, without replaying paused slots.
- Use the schedule on one laptop per Naukri account. Two computers can otherwise edit the same profile.

If a reliable account id is not visible, automatic runs do not edit. That is intentional.

## 6. Update

Rebuild in the same `dist/extension/` folder and click Reload on `chrome://extensions`. Do not remove the extension if you need to keep the saved PDF, schedule, and history. Moving the folder or reloading it from a new path can change the extension id and orphan that data.

## 7. Another laptop or Chrome profile

Install it again there. Sign in, choose the PDF, and set the schedule yourself. Nothing is copied across profiles or machines.

## 8. Troubleshooting

- Sign-in expired: use Check connection and sign in on the Naukri tab.
- Saved resume missing or corrupt: choose the PDF again. The message is `Saved resume is unavailable. Please select it again.`
- Unknown account: confirm the account before a manual run. Scheduled runs stay off until an account id can be checked. Disconnect / rebind clears the local binding. It does not sign you out of Naukri.
- Action required: a challenge, access block, or rate limit stops automatic runs. Resolve it on Naukri, then use Resume automation. The extension will not solve a challenge or keep retrying.
- Profile layout could not be verified: Naukri's page did not match the expected controls. Nothing is guessed.
- No run while the laptop slept: open Chrome later the same day. At most one catch-up runs.
- Upload unverified: the extension will not upload again by itself. Review the unresolved update. A same-day filename is not treated as proof.
- Partial run: history shows which steps were verified. Retry continues only when that is safe. Cancel stops at the next step. It does not undo a save Naukri already accepted.
- Reset deletes this extension's local settings, schedule, log, and PDF copy. It does not delete the original file on disk or change Naukri. Uninstall removes the extension's own storage only.

## 9. Privacy

Local settings, logs, and the PDF copy are sensitive and are not encrypted by the extension. Anyone who can use this Chrome profile can read them. Naukri receives the profile text and resume you submit. This extension does not send them to any other server and does not add analytics. Do not share `dist/extension/` together with a real resume or a Chrome profile copy.

## Manual acceptance

These checks need a normal Chrome profile and a non-sensitive PDF. They were not run in the automated suite. Do not point them at a real Naukri account unless you are allowed to.

- [ ] Build the extension and load `dist/extension/` with Developer mode > Load unpacked. No manifest errors.
- [ ] Popup and options show the version, an empty state, schedule off, and the local-only warning.
- [ ] Connect while signed out, sign in yourself, and check the connection status.
- [ ] Select a PDF and read the filename preview. An invalid or oversized file is rejected and the previous valid file remains.
- [ ] Run now with the actions you intend, only if terms allow a real edit. Confirm the headline, summary, and resume evidence on Naukri, including the local date in the file name.
- [ ] Custom mode twice does not stack the suffix, and an unchanged field is not described as refreshed.
- [ ] Text-only run without a PDF, and upload-only, each touch only the selected action.
- [ ] A time two minutes ahead runs once, notifies once, and shows the next time. Only if automation is permitted.
- [ ] A time in the current or past minute does not run immediately.
- [ ] Quit Chrome before a future slot and reopen later the same day. Exactly one catch-up.
- [ ] Several missed slots become one catch-up, and the next day uses the wall clock.
- [ ] Schedule off stops later runs. Pause today and resume today behave as described.
- [ ] Close the popup during a run and reopen it. Progress is still there. Tab close and worker stop do not report false success.
- [ ] Session expiry, account mismatch, and a challenge fixture do not bypass the stop.
- [ ] An ambiguous same-day upload is not reported as success from the filename or date alone.
- [ ] Reload in place keeps the PDF and settings and does not duplicate alarms.
- [ ] A second Chrome profile has its own data.
- [ ] Clear log, remove the test resume, and reset. Only local extension data changes.
- [ ] The extension console shows no sensitive data and no unexpected network calls.
- [ ] Desktop tests still pass and the website is unchanged.

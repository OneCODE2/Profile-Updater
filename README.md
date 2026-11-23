# Naukari Profile Updater

Electron mini-app that keeps a Naukri profile fresh: cycles a trailing dot on the headline/summary, renames a resume copy, and re-uploads it on a schedule.

## Setup

```bash
npm install
```

## Run

```bash
npm start
```

Background / tray (no window until you open it from the tray):

```bash
npm run start:bg
```

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

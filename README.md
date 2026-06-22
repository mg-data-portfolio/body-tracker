# Body Tracker

A single-device body-composition tracker: daily calories, morning weight (kg) and
body-fat %, with 7-day averages, a regression-based TDEE estimate (with a
Mifflin-St Jeor baseline before enough data exists), phase recommendations
(bulk / cut / maintain), evidence-based calorie and macro targets, a 2-week
target-adjustment cycle, goal-weight projection, phase history, consistency stats,
trend charts (including a weight/body-fat dual-axis overlay with phase-change
markers), light/dark themes, a what-if calorie preview, weekly summaries,
diet-break suggestions, weight-outlier flagging, a missing-entry nudge, a
selectable-range report with auto-generated insights (exportable as PDF or
Markdown), and offline PWA support (installable to your home screen).

Your profile (DOB, height, sex, activity) is set via the ⚙ button, top-right.

Data is stored locally in your browser via `localStorage` — no account, no server,
no cost. It lives on whatever device/browser you use, so use the **Export** menu
(top-right ⋮) to back up if you clear your browser or switch phones.

---

## 1. One-time setup

You need [Node.js](https://nodejs.org) (v18 or newer). Check with:

```bash
node --version
```

Then, in this folder:

```bash
npm install
```

That downloads the dependencies into `node_modules/` (takes ~30s, only needed once).

## 2. Run it locally

```bash
npm run dev
```

Vite prints a local URL (usually `http://localhost:5173`). Open it in your browser.
Edits to `src/App.jsx` hot-reload instantly — no restart needed.

To test on your **phone** while developing: run `npm run dev -- --host`, then open the
"Network" URL it prints (e.g. `http://192.168.1.x:5173`) on your phone. Phone and
computer must be on the same Wi-Fi.

## 3. Put it on your phone for real (host it)

The easiest free host is **Vercel**:

1. Push this folder to a GitHub repo.
2. Go to [vercel.com](https://vercel.com), "Add New Project", import the repo.
3. Vercel auto-detects Vite. Leave defaults (build: `npm run build`, output: `dist`).
   Click Deploy.
4. You get a URL like `body-tracker-xyz.vercel.app`. Open it on your phone, then
   **Add to Home Screen** — it behaves like an app.

After this, every `git push` redeploys automatically in under a minute.

Alternatively, `npm run build` produces a static `dist/` folder you can drop onto any
static host (Netlify, GitHub Pages, Cloudflare Pages, etc.).

### Installable app (PWA) & offline

The app ships with a web manifest, icons, and a service worker, so once hosted over
HTTPS (Vercel/Netlify give you this automatically) it can be **installed to your home
screen** and works **offline** — your data is local anyway. The service worker is
network-first for the app shell, so deploys still pick up changes on next load.

Note: the service worker only activates when served over HTTPS or from `localhost`. It
does nothing during `npm run dev`, which is expected.

### Light / dark theme

Toggle with the ☀/☾ button, top-right. Your choice is saved. Dark is the default.

### Report

The **Report** tab builds a summary for any date range (week / month / quarter /
custom) — weight and body-fat change with weekly rate, average calories and
protein, target adherence, phases active during the period, goal pace, and a
list of auto-generated insights (e.g. flagging if you were consistently over
target, behind goal pace, or overdue a diet break).

Export it as:
- **PDF** — opens a clean printable layout in a new tab and triggers the
  browser's print dialog; choose "Save as PDF" as the destination. If your
  browser blocks the pop-up, allow pop-ups for the site and try again.
- **Markdown (.md)** — downloads a plain-text file, or **Copy** puts it on your
  clipboard to paste into notes, email, or a coach's app.

---

## Making changes later

Everything lives in **`src/App.jsx`** (one file). Common edits:

- **Phase calorie math / magnitudes** — the `PHASES` object near the top.
- **TDEE method or windows** — `calcTDEEWindow` and the `tdeeWindow` state.
- **Macro ratios (protein/fat g per kg)** — `calcMacros`.
- **Body-fat recommendation thresholds** — `recommendPhase`.
- **Chart ranges** — the `RANGES` object.
- **Storage keys** — `STORAGE_KEY` / `SETTINGS_KEY` (changing these resets saved data).

Run `npm run dev` while editing to see changes live.

## Export / backup

The ⋮ menu (top-right) offers:

- **Save to Google Drive** — downloads a CSV and opens Drive so you can drop it in.
- **Download CSV** — opens cleanly in Sheets/Excel (columns: date, calories, weight_kg, body_fat_pct, protein_g).
- **Download JSON** — full backup including your settings; keep this to restore data.
- **Copy to clipboard** — paste straight into a spreadsheet.
- **Import from file** — restore a previously exported JSON or CSV. If you already have
  data, it asks whether to **merge** (imported values win on shared dates) or **replace**
  everything. A JSON backup also restores your phase/window settings.

### About Google Drive
A true one-tap upload into Drive requires Google OAuth and API credentials, which is
more setup than a single-device app needs. The current "Save to Drive" downloads the
file and opens Drive for a manual drop. If you later want genuine direct upload, that's
a defined next step — ask and it can be wired in.

## Notes on the numbers

- Weight is in **kg**; TDEE uses 7,700 kcal/kg.
- TDEE is a least-squares trend over 14 or 28 days (toggle), not a noisy 7-day delta.
- Calorie targets only appear once there's enough data (≥10 days), are rounded to
  25 kcal for stability, and flag low confidence when the 14- and 28-day windows
  disagree by more than 300 kcal.
- The target is **held fixed for 2 weeks at a time**. At the end of each cycle the app
  compares your actual weight-trend rate to the goal rate and proposes a ±150 kcal
  adjustment for your approval — so calories never drift on daily noise. Changing
  phase or intensity starts a fresh cycle.
- Before ~10 days of data exist, a **Mifflin-St Jeor baseline** (from your profile) gives
  a sensible starting target; it's replaced by your measured TDEE once that's reliable.
- Recommendation thresholds assume an intermediate **male** lifter; add ~8–10% for
  female body-fat ranges. This is general fitness guidance, not medical advice.

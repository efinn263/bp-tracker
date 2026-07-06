# BP Tracker

Blood pressure & heart rate PWA — installable on Android, works in any browser.

---

## Deploying to GitHub Pages (step by step)

### 1. Create the repository
1. Go to [github.com/new](https://github.com/new) — log in as **efinn263**
2. Repository name: `bp-tracker` (or anything you like)
3. Set to **Public**
4. Leave everything else as default — click **Create repository**

### 2. Upload all files
1. On the new repo page, click **"uploading an existing file"** (or the "Add file" → "Upload files" button)
2. Drag the entire contents of the `bp-tracker` folder into the upload area
   - **Important:** upload the *contents* of the folder, not the folder itself
   - You should see: `index.html`, `manifest.json`, `sw.js`, `css/`, `js/`, `icons/`
3. Click **Commit changes**

### 3. Enable GitHub Pages
1. In your repo, go to **Settings** → scroll down to **Pages**
2. Under **Source**, select **"Deploy from a branch"**
3. Branch: **main** — Folder: **/ (root)**
4. Click **Save**
5. Wait ~1–2 minutes. Your app will be live at:

```
https://efinn263.github.io/bp-tracker/
```

### 4. Install on Android
1. Open Chrome on your Android phone
2. Navigate to `https://efinn263.github.io/bp-tracker/`
3. Tap the **three-dot menu** (⋮) → **"Add to Home Screen"**
4. Tap **Add** — the app icon will appear on your home screen
5. Launch it like any other app — it works offline too

---

## Features

- **Dashboard** — interactive time chart with pinch/scroll zoom and drag to pan
- **Add Reading** — manual entry with date/time, systolic, diastolic, BPM, notes
- **Medications** — log doses with before/after windows; auto-calculates % BP reduction
- **Import** — drag & drop CSV or XLSX from your Pressure XS Pro (long format supported directly); JSON backup restore
- **Settings** — export to CSV or JSON backup; clear data

## Data

All data is stored locally on your device using IndexedDB. Nothing is sent anywhere.
Use **Settings → Export backup** regularly to keep a safe copy.

## Import format (Pressure XS Pro)

Your device export (long format) works directly — no changes needed:
```
Device,Metric,Value,Time
Pressure XS Pro,sys,124,2026-06-22 06:34:00Z
Pressure XS Pro,dia,75,2026-06-22 06:34:00Z
Pressure XS Pro,bpm,67,2026-06-22 06:34:00Z
```

Wide format (Systolic/Diastolic/BPM columns) is also supported.


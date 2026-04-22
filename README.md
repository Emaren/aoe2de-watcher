# AoE2DEWarWagers Watcher

Electron helper that watches the Age of Empires II: Definitive Edition replay folder, emits live replay snapshots while a match is in progress, uploads the final replay when the file settles, and can scan/import older saved replays on demand.

This is the mac-first DE watcher for AoE2DEWarWagers. The old HD watcher archive is useful as a packaging and UX blueprint only; this source must stay DE-branded and DE-wired.

## What it owns

- App/product name: `AoE2DEWarWagers Watcher`
- Pairing protocol: `aoe2de-watcher://pair?apiKey=...`
- Pairing page: `https://aoe2dewarwagers.com/profile?watcher_pair=1`
- Primary upload endpoint: `https://api-prodn.aoe2dewarwagers.com/api/replay/upload`
- Fallback upload endpoint: `https://aoe2dewarwagers.com/api/replay/upload`
- mac app bundle: `AoE2DEWarWagers Watcher.app`
- mac DMG: `dist/AoE2DEWarWagers Watcher-1.1.2-arm64.dmg`
- mac direct ZIP: `dist/AoE2DEWarWagers-watcher-direct.zip`

## Owning files

- Packaging/product metadata: `package.json`
- mac icon and entitlements: `build/icon.icns`, `build/icon.png`, `build/aoe2dewarwagers-watcher-logo.png`, `build/entitlements.mac.plist`, `build/entitlements.mac.inherit.plist`
- Electron shell, config defaults, pairing protocol: `main.js`
- DE replay folder discovery and upload runtime: `watcher.js`
- Renderer defaults, support snapshot, log/status copy: `renderer.js`
- Watcher UI shell and outbound DE links: `index.html`
- Direct ZIP artifact layout: `scripts/build-manual-zip.mjs`
- Notarization hook: `scripts/notarize.js`
- Runtime/env example: `.env.example`
- Regression checks: `watcher.test.js`

## Default DE replay folder detection

On macOS, auto-detect scans CrossOver bottles for the real DE Windows profile path:

```text
~/Library/Application Support/CrossOver/Bottles/<Bottle>/drive_c/users/<user>/Games/Age of Empires 2 DE/<steam-id>/savegame
```

It also checks the `AppData/Local/Games/Age of Empires 2 DE/<steam-id>/savegame` variant and native/proton-style DE profile roots. It does not fall back to HD install folders.

## Quick Start

```bash
cd /Users/tonyblum/projects/AoE2DEWarWagers/aoe2de-watcher
cp .env.example .env
npm install
npm run start
```

The desktop app expects a watcher key before uploads begin. The preferred path is one-click pairing:

1. Launch the app.
2. Click **Open Profile Pairing**.
3. Approve the `aoe2de-watcher://` handoff in your browser.

That mints a fresh watcher key on `https://aoe2dewarwagers.com/profile?watcher_pair=1`, saves it to local app config, and auto-starts when the replay folder is known. If macOS blocks the custom URL, use **Mint Key** on `/profile` and paste the fallback key into the app once.

## mac arm64 build

```bash
cd /Users/tonyblum/projects/AoE2DEWarWagers/aoe2de-watcher
rm -rf dist
npm ci
npm run dist:mac
npm run dist:manual-zip
```

Expected artifacts:

```text
dist/AoE2DEWarWagers Watcher-1.1.2-arm64.dmg
dist/AoE2DEWarWagers Watcher-1.1.2-arm64.dmg.blockmap
dist/AoE2DEWarWagers-watcher-direct.zip
dist/mac-arm64/AoE2DEWarWagers Watcher.app
dist/latest-mac.yml
```

Optional sync into the web app download rail:

```bash
cd /Users/tonyblum/projects/AoE2DEWarWagers/app-prodn
npm run watcher:sync
```

## Historical import

The main window includes **Scan & Import Replays**.

- scans the configured DE `savegame` folder
- handles `.aoe2record` and `.aoe2mpgame`
- processes files oldest-to-newest
- keeps live watching available
- shows found / queued / skipped / uploaded / failed counts
- stores failed uploads so they can be retried from the same UI

## Optional environment variables

- `AOE2_API_BASE_URL` (default: `https://api-prodn.aoe2dewarwagers.com`)
- `AOE2_API_FALLBACK_BASE_URL` (default: `https://aoe2dewarwagers.com`)
- `AOE2_WATCH_DIR` (optional manual DE `savegame` override)
- `WATCHER_USER_UID` (default: hostname-derived watcher id)
- `AOE2_UPLOAD_API_KEY` (optional manual fallback; one-click pairing normally fills this in)
- `AOE2_UPLOAD_RETRY_ATTEMPTS` (default: `4`)
- `AOE2_UPLOAD_RETRY_BASE_DELAY_MS` (default: `4000`)
- `AOE2_UPLOAD_STABLE_CHECK_INTERVAL_MS` (default: `3000`)
- `AOE2_UPLOAD_QUIET_PERIOD_MS` (default: `30000`)
- `AOE2_INITIAL_LIVE_DELAY_MS` (default: `3000`)
- `AOE2_INITIAL_LIVE_RETRY_COOLDOWN_MS` (default: `10000`)
- `AOE2_LIVE_UPLOAD_COOLDOWN_MS` (default: `45000`)

## Verification checklist

Run these before cutting a mac release:

```bash
cd /Users/tonyblum/projects/AoE2DEWarWagers/aoe2de-watcher
npm test
rg -n "AoE2HD|aoe2hd|Age2HD|Age of Empires 2 HD|hdbets|HDBets|api-prodn\\.aoe2hdbets|aoe2hdbets\\.com" package.json main.js watcher.js renderer.js index.html .env.example scripts
rg -n "AoE2DEWarWagers Watcher|aoe2de-watcher|api-prodn\\.aoe2dewarwagers\\.com|aoe2dewarwagers\\.com|Age of Empires 2 DE" package.json main.js watcher.js renderer.js index.html .env.example scripts README.md
npm run dist:mac
npm run dist:manual-zip
plutil -p "dist/mac-arm64/AoE2DEWarWagers Watcher.app/Contents/Info.plist" | rg "AoE2DEWarWagers|aoe2de-watcher|com\\.aoe2dewarwagers"
ditto -x -k "dist/AoE2DEWarWagers-watcher-direct.zip" /tmp/aoe2dewarwagers-watcher-check
test -d "/tmp/aoe2dewarwagers-watcher-check/AoE2DEWarWagers Watcher Direct/AoE2DEWarWagers Watcher.app"
```

The second command should produce no source hits. The later checks prove the bundle name, protocol, app id, DMG, ZIP, and runtime source strings are DE-native.

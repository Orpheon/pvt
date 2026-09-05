# PVT

A phone-first psychomotor vigilance test (Basner & Dinges PVT-B protocol) for tracking sleep debt against your own history.
Single static page, installable as a PWA, data stays on the device, CSV export via the share sheet.

## Install on Android

1. Open the hosted URL in Chrome.
2. Menu (⋮) → **Install app** (not "Add to Home screen").
3. Launch from the app drawer or Niagara. It runs offline from then on.

## Files

- `index.html` – the whole app
- `manifest.webmanifest`, `sw.js`, `icon-*.png` – PWA plumbing
- Bump `CACHE` in `sw.js` whenever `index.html` changes, otherwise installed phones keep the old version one launch longer.

## Data

Sessions are stored in the browser's localStorage for this origin. Export summary CSV, raw trial CSV, or a JSON backup from the Data section. Restore JSON merges by session id.

## Tests

`node test/run.mjs [outdir]` drives headless Chrome (needs `google-chrome` on PATH, or set `CHROME`): runs a shortened test with simulated taps, seeds edge-case histories (one day of sessions with sub-percent differences, identical sessions, a month of near-identical values, a single session), asserts on axis labels, deltas, the score formula and the CSV, and writes screenshots to the output directory.

---
name: screenshot
description: Capture a PNG of the local web app at a given route, optionally with seeded localStorage. Use this any time you've changed UI code and need to actually see what rendered. Returns a path you can Read as an image.
---

# screenshot

Drives headless Chromium against `http://127.0.0.1:5173` via `scripts/screenshot.mjs`. The Bash wrapper prints the output path as the LAST line of stdout — Read that path with the Read tool to view the image.

## Preflight

The script does NOT start the dev stack. If you get `dev server not reachable at http://127.0.0.1:5173`, run:

```
npm run dev-stack -- up
```

then retry.

## Basic usage

```bash
npm run screenshot -- --route=/session --seed=signed-in
```

The output PNG is written to `.claude/screenshots/<timestamp>-<slug>.png` and the path is echoed to stdout. The dir is gitignored.

## Flags

- `--route=<path>` — SPA route, default `/`. Leading-slash safe (Git Bash mangles `/x` → `C:/Program Files/Git/x`; the script detects and undoes this)
- `--seed=<preset[,…]>` — comma-separated seeds applied to `localStorage` before the SPA boots. Defined presets:
  - `signed-in` — fake learner row, marks placement + onboarding complete (skips /signup, /placement)
  - `dev-mode` — turns on Developer tab in the Settings drawer
  - `tts-openai` — sets TTS voice to OpenAI gpt-4o-mini-tts
- `--selector=<css>` — wait for this element to become visible before capturing (timeout 5s, capture-anyway-on-fail)
- `--click=<css>` — click this element after load, before capturing. **Pass multiple times** to click in sequence (e.g. open drawer THEN switch tab), 300ms gap between each.
- `--wait=<ms>` — extra delay after navigation, default 600ms (animations)
- `--base-url=<url>` — override the dev server URL. Default: auto-probe 5173..5180 for a vite serving OUR SPA (rejects unrelated servers)
- `--out=<path>` — override output path
- `--full-page` — capture full scroll height (default is viewport only)
- `--viewport=<WxH>` — default `412x892` (mobile portrait — matches the app's design target)

## Common recipes

Just the home page after signup:
```bash
npm run screenshot -- --route=/home --seed=signed-in
```

The Developer tab of the settings drawer with the Live Session panel POPULATED (verifies KvList rows, recent turns, uptime, etc.):
```bash
npm run screenshot -- --route=/session --seed=signed-in,dev-mode --inject-session \
  --click="[data-testid=btn-menu]" --click="button:has-text('DEVELOPER')" --wait=1500
```
- The two `--click`s open the drawer, then switch to the Developer tab.
- `--inject-session` is **required** to render anything inside the Live Session panel — without it, the panel short-circuits to its empty placeholder because no real LiveKit room is joined in headless. The flag stubs `room`, `agent`, `turns`, and `ptt` into `window.__habla_devbus__` AFTER the drawer is open, then waits for React to re-render.

The same Developer tab WITHOUT a fake session (to verify the empty-state path):
```bash
npm run screenshot -- --route=/session --seed=signed-in,dev-mode \
  --click="[data-testid=btn-menu]" --click="button:has-text('DEVELOPER')" --wait=1500
```

A specific test-id you just added:
```bash
npm run screenshot -- --route=/session --seed=signed-in --selector="[data-testid=your-new-thing]"
```

## After capture

Read the returned PNG path with the Read tool. You'll see the image inline.

## Adding seed presets

Edit `SEEDS` in `scripts/screenshot.mjs` if you need new fixture state. The keys must match the localStorage keys read by `web/src/lib/api.ts` and `web/src/lib/dev-bus.ts`.

## Limitations

- Headless Chromium — no real audio, no LiveKit room join. For audio-driven flows use the audio team's tool to inject sound, then call screenshot to capture the result.
- The dev-mode seed enables the developer tab; if your change is in a session that hasn't started, you may also need to drive the orb / start-session button via `--click`.
- The script auto-probes 5173..5180 for our SPA, but it does NOT start vite. Launch vite via `Bash(command: "npm run dev --prefix web", run_in_background: true)` if no port responds (run `npm run dev-stack -- up web` to see the exact command).
- "Live Session" panel needs `--inject-session` to render its populated branch (see the recipe above). Without it, you'll only ever see the placeholder.
- The injected session uses *stub* data — it can verify rendering and layout, but obviously not real LiveKit state or pronunciation values.

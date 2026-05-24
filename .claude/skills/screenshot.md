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

- `--route=<path>` — SPA route, default `/`
- `--seed=<preset[,…]>` — comma-separated seeds applied to `localStorage` before the SPA boots. Defined presets:
  - `signed-in` — fake learner row, marks placement + onboarding complete (skips /signup, /placement)
  - `dev-mode` — turns on Developer tab in the Settings drawer
  - `tts-openai` — sets TTS voice to OpenAI gpt-4o-mini-tts
- `--selector=<css>` — wait for this element to become visible before capturing (timeout 5s, capture-anyway-on-fail)
- `--click=<css>` — click this element after load, before capturing (use for opening the drawer, e.g. `[data-testid=btn-menu]`)
- `--wait=<ms>` — extra delay after navigation, default 600ms (animations)
- `--out=<path>` — override output path
- `--full-page` — capture full scroll height (default is viewport only)
- `--viewport=<WxH>` — default `412x892` (mobile portrait — matches the app's design target)

## Common recipes

Just the home page after signup:
```bash
npm run screenshot -- --route=/home --seed=signed-in
```

The Developer tab of the settings drawer (verifies the live-session panel):
```bash
npm run screenshot -- --route=/session --seed=signed-in,dev-mode --click="[data-testid=btn-menu]" --wait=1000
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
- The script bails if the dev server isn't on `:5173`. It will NOT start it for you.

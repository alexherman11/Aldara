# Habla — voice-first Spanish tutor (prototype)

A real-time conversational Spanish tutor built around a single voice agent
("Sofía"). You tap the orb, push to talk, and a LiveKit-backed pipeline
(Deepgram → GPT‑4o → Cartesia) runs the conversation. At the end of a
session, Claude (Sonnet) compacts the transcript into a structured
learner/tutor core and updates FSRS spaced-repetition cards in Postgres.

```
           ┌────────────┐
 mic ────► │  Deepgram  │ ──► transcript
           └────────────┘
                  │
                  ▼
           ┌────────────┐
           │   GPT-4o   │ ◄── learner_core + tutor_core (JSONB)
           └────────────┘         + FSRS due cards
                  │
                  ▼
           ┌────────────┐
           │  Cartesia  │ ──► Sofía's voice
           └────────────┘

  End session ─► Claude (Sonnet) compaction
     • diff cores  → save back to learners.{learner_core, tutor_core}
     • upsert FSRS → rate items via ts-fsrs, write fsrs_cards
```

You can see the live pipeline + cores + last compaction result in the
**Debug** tab of the side drawer.

## Local dev

Single machine, single user, single Postgres database.

### 1. Prerequisites

- Node 22+
- Postgres 14+ running locally (or any reachable host)
- Accounts / keys for: Deepgram, OpenAI, Anthropic, Cartesia, LiveKit
  (free tiers are fine)

### 2. Configure env

```sh
cp .env.example .env
# Fill in the API keys. DATABASE_URL defaults to a local postgres on :5432
```

### 3. Install + create the database

```sh
npm install
npm install --prefix web
npm run setup-db     # creates the "habla" database (if absent) and applies the schema
```

The schema is idempotent — re-running `setup-db` is safe.

### 4. Run everything

```sh
npm run dev
```

This launches three processes in parallel via `concurrently`:

| Name    | Port  | What                                              |
| ------- | ----- | ------------------------------------------------- |
| livekit | 7880  | Self-hosted `livekit-server.exe` (loopback only). Both browser and agent connect here. |
| server  | 3000  | Express token-server + /api/* (token, learner CRUD, debug) |
| agent   | —     | LiveKit Agent worker (Sofía). Connects to local livekit at :7880. |
| web     | 5173  | Vite dev server. Proxies /api to :3000. Open this one. |

#### LiveKit: self-hosted vs Cloud

Default is **self-hosted** — saves you LiveKit Cloud free-tier minutes for the
times you actually need remote testers. One-time setup:

1. Download the Windows release zip from
   <https://github.com/livekit/livekit/releases/latest> (asset
   `livekit_*_windows_amd64.zip`).
2. Extract `livekit-server.exe` into `tools/livekit/` next to the existing
   `livekit.yaml`.
3. That's it — `npm run dev` now boots it as the `livekit` pane on `:7880`.

The API key/secret in `tools/livekit/livekit.yaml` must match `LIVEKIT_API_KEY`
/ `LIVEKIT_API_SECRET` in `.env`. The binary is gitignored.

To switch back to Cloud, set `LIVEKIT_URL=wss://<your-project>.livekit.cloud`
in `.env` and drop the `livekit` entry from the `dev` script in `package.json`
(or just ignore the extra pane — the agent picks whichever URL `.env` has).

Open <http://127.0.0.1:5173>. The first time, you'll be routed to **/signup**.
Signup posts to `/api/learner` which creates a row in Postgres and stamps the
learner id into localStorage. The id then travels through LiveKit dispatch
metadata so the agent loads the correct learner on every session.

If you only want the backend running and don't need the Vite dev server, use:

```sh
npm run server   # Express only
npm run agent    # LiveKit worker only
```

### 5. Build for production

```sh
npm run build    # builds frontend into web/dist
npm run server   # token-server now serves web/dist at /, /api/* still works
```

In prod mode the token-server is the only port you expose.

## Onboarding flow

```
/signup        — name, email, age, CEFR self-assessment
   ↓ POST /api/learner  → returns learner.id (UUID), stored locally
/assessment    — 3-step welcome screens (Sofía explains herself)
   ↓
/daily-goal    — pick 10/15/20 min/day (PATCH /api/learner/:id)
   ↓ marks learner as onboarded
/home          — orb. Tap to begin.
   ↓
/session       — LiveKit room. Hold mic / Space to talk.
   ↓ end session → end_session RPC → Claude compaction
/summary       — shows compaction result (new FSRS cards, Sofía's note)
   ↓
/home
```

## Key files

| Backend                                       | Frontend                                       |
| --------------------------------------------- | ---------------------------------------------- |
| `src/agent.ts` — LiveKit agent worker (Sofía) | `web/src/App.tsx` — routing + onboarding guard |
| `src/token-server.ts` — Express + /api/*      | `web/src/pages/Session.tsx` — live LiveKit room |
| `src/compaction.ts` — Claude post-session run | `web/src/pages/Signup.tsx` — creates learner   |
| `src/difficulty-controller.ts` — adaptive difficulty | `web/src/components/SettingsDrawer.tsx` — profile / progress / debug |
| `src/pronunciation/` — STT-side assessors     | `web/src/components/Orb.tsx` — the animated orb |
| `src/db/index.ts` — Postgres queries          | `web/src/lib/api.ts` — API client + local user store |

## Troubleshooting

- **Mic blocked**: Chrome blocks getUserMedia on `http://` outside `localhost`.
  Use `http://127.0.0.1:5173`, not `0.0.0.0` or a LAN IP.
- **"Connection failed" on /session**: token-server isn't running on :3000, or
  `LIVEKIT_URL` / `LIVEKIT_API_*` in `.env` is wrong.
- **Orb stays idle and "Hold to speak" is greyed out**: the agent worker
  hasn't joined the room yet. Check the `agent` pane's logs.
- **Compaction returns "Nothing to compact"**: you ended the session without
  any final transcript turns. PTT requires a successful Deepgram final segment.

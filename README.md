# Titanium Quoridor Coordinator

Repo: [github.com/titaniummachine1/Titanium-Quoridor-Coordinator](https://github.com/titaniummachine1/Titanium-Quoridor-Coordinator)

Cloudflare Worker that coordinates distributed SPRT testing of the Titanium
Quoridor engine (Fishtest-style, hobby scale).

## Deploy

```bash
npm i -g wrangler
wrangler login
wrangler kv namespace create QKV        # paste id into wrangler.toml
wrangler secret put WEBHOOK_SECRET      # same value as the GitHub webhook secret
wrangler secret put OWNER_TOKEN         # any long random string; keep private
wrangler deploy
```

Then add a webhook on the **engine repo**: Settings → Webhooks →
`https://<worker>.workers.dev/webhook`, content type `application/json`,
secret = `WEBHOOK_SECRET`, event = push.

## API

| Method | Path | Who | Purpose |
|---|---|---|---|
| POST | `/webhook` | GitHub | push event → debounce + queue SPRT batches |
| GET | `/api/job?worker=ID` | test-client | claim a job |
| POST | `/api/result` | test-client | submit `{job_id, wins, losses, draws}` |
| GET | `/api/status` | anyone | mode, queue depth, monthly spend |
| GET | `/api/result/<sha>` | website | published verdict JSON |
| POST | `/api/mode` | owner | `{"mode":"FRUGAL"}` (Bearer OWNER_TOKEN) |
| POST | `/api/spend-cap` | owner | `{"eur":15}` (absolute ceiling €50 in code) |

## Modes

FRUGAL ($0.00, queue forever) / BALANCE (≤€3.50/mo) / SPEED (≤cap, default €15).
The Hetzner escape-valve + reaper cron land in Phase 5; the config/spend
plumbing they need is already here.

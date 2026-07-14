# 🪝 WebhookCatcher

Self-hosted webhook relay in a single Docker container: **catch** webhooks, **inspect** them live, **transform** the payload with [JSONata](https://jsonata.org), and **forward** it to another webhook — with automatic retries, replay, manual triggering, a status page, user management, and full per-event logging.

```
Sender ──POST /hooks/:slug──▶ Catch ──▶ Store ──▶ Transform ──▶ Forward ──▶ Destination
                                │ 200 OK           (retries: 30s, 2m, 10m, 1h, 6h → dead)
                                ▼
                          Live inbox (SSE)
```

Every webhook is stored durably **before** the sender is acked, then transformed and delivered asynchronously — a slow or broken destination never loses a webhook.

## Features

- **Live inbox** — see webhooks the moment they arrive (SSE), with full headers, payload, transformed output, and a per-event delivery timeline
- **JSONata transforms** per route, with a live preview editor
- **Reliable delivery** — exponential-backoff retries, dead-letter state, one-click replay
- **Manual trigger** — fire the whole pipeline with a hand-written payload
- **HMAC verification** of incoming webhooks (GitHub/Stripe style signing secrets)
- **Status page** + public `/health` endpoint + Uptime Kuma push support
- **Login & user management** — everything except the catch URLs is behind authentication
- **Zero external dependencies** — one container; SQLite (built into Node.js) on a volume

## Deploy

Requirements: Docker with the compose plugin.

```bash
git clone https://github.com/Youdo365/WebhookCatcher.git
cd WebhookCatcher
# 1. edit docker-compose.yml and set ADMIN_PASSWORD
docker compose up -d --build
```

- Dashboard: `http://<server>:8090` — log in as `admin` with the password you set
- Catch URLs: `http://<server>:8090/hooks/<slug>`
- Data persists on the `webhook-data` volume across restarts and upgrades

Verify:

```bash
docker compose ps                  # STATUS should show (healthy)
docker compose logs -f             # structured JSON logs
curl http://localhost:8090/health  # {"status":"ok",...}
```

### Update

```bash
git pull
docker compose up -d --build       # data volume is untouched
```

### Backup / restore

All state is one SQLite database on the `webhook-data` volume:

```bash
docker run --rm -v webhook-data:/data -v "$PWD":/backup alpine tar czf /backup/webhook-data.tar.gz -C /data .   # backup
docker run --rm -v webhook-data:/data -v "$PWD":/backup alpine tar xzf /backup/webhook-data.tar.gz -C /data     # restore
```

### Expose to the internet

Put a reverse proxy with automatic TLS in front — e.g. Caddy:

```
hooks.example.com {
    reverse_proxy webhook-catcher:8090
}
```

The app is proxy-aware (`trustProxy`): real client IPs are logged and the session cookie is marked `Secure` over HTTPS. Before going public: set a strong `ADMIN_PASSWORD`, and use per-route signing secrets so strangers can't POST fake events to your catch URLs.

## Configuration

Set in `docker-compose.yml`:

| Env var | Default | Purpose |
|---|---|---|
| `ADMIN_PASSWORD` | `change-me` | Password for the `admin` user (re-applied on every start) |
| `UPTIME_KUMA_PUSH_URL` | *unset* | Uptime Kuma push-monitor URL; when set, the app pings it every minute |
| `PORT` / `HOST` / `DATA_DIR` | `8090` / `0.0.0.0` / `/data` | Already set correctly for Docker |

Manage additional users on the dashboard's **Users** page. The in-app **Help** page explains the pipeline, transforms, and monitoring for end users.

## Monitoring (Uptime Kuma)

- **HTTP(s) monitor**: point Kuma at `/health` — public, no data exposed; `200` while the delivery worker is alive, `503` if it stalls.
- **Push monitor**: paste Kuma's push URL into `UPTIME_KUMA_PUSH_URL` in the compose file; the app pings it every minute, so Kuma alerts if the app dies.

## Development

The app is TypeScript (Fastify + `node:sqlite` + JSONata). To hack on it you need Node.js ≥ 22.13:

```bash
npm install
npm test        # unit tests (transform engine, retries, auth)
npm run dev     # local dev server on http://127.0.0.1:8090
```

The Docker image is a multi-stage build — `npm run build` compiles to `dist/`, and the runtime stage contains only production dependencies. No native modules anywhere.

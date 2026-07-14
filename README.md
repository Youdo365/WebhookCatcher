# Webhook Catcher

Catch webhooks, inspect them live, transform the payload with [JSONata](https://jsonata.org), and forward it to another webhook — with delivery retries, replay, manual triggering, a status page, and full per-event logging.

## Quick start

```bash
npm install
npm run dev        # http://127.0.0.1:8090
```

1. Sign in as `admin` — on first start a password is generated and printed in the server logs (set the `ADMIN_PASSWORD` env var to choose your own). Add more users on the **Users** page.
2. Open the dashboard → **Routes** → **New route**. Give it a slug (e.g. `orders`), optionally a destination URL and a JSONata transform.
2. Point a webhook sender at `http://<host>:8090/hooks/orders`.
3. Watch it arrive live in the **Inbox**; click an event to see the raw payload, transformed output, and delivery timeline.

## How it works

```
Sender ──POST /hooks/:slug──▶ Ingest ──▶ SQLite ──▶ Delivery worker ──POST──▶ Destination
                                │ 200 OK            (transform + retry backoff:
                                ▼                    30s, 2m, 10m, 1h, 6h → dead)
                          Live inbox (SSE)
```

- The sender is acked immediately after the event is durably stored; transform + forwarding happen asynchronously so slow destinations never block ingest.
- Transforms are pure JSONata expressions over `{ headers, body, route }` — preview them in the route editor against a sample payload before saving.
- **Replay** re-runs any stored event; **Trigger** fires the pipeline with a hand-written payload (`POST /api/routes/:id/trigger`).
- **Status** page shows per-route health, 24h counts, and delivery-worker heartbeat (`GET /api/status`).
- Structured JSON logs (pino) correlate every stage by `eventId`.

## Deploying with Docker

The app ships as a single container: web server, delivery worker, and SQLite all in one process. The image is a multi-stage build on `node:24-alpine` (no native modules — SQLite is built into Node), runs as the unprivileged `node` user, and includes a healthcheck against `/api/status`.

### Prerequisites

- Docker Engine with the compose plugin (on a server: `curl -fsSL https://get.docker.com | sh`; on Mac/Windows: Docker Desktop)

### Deploy

```bash
git clone https://github.com/Youdo365/WebhookCatcher.git
cd WebhookCatcher
docker compose up -d --build
```

That's it — the dashboard is on `http://<server>:8090` and catch URLs are `http://<server>:8090/hooks/<slug>`. The compose file:

- builds the image locally,
- publishes port **8090**,
- stores the SQLite database on a named volume (`webhook-data`), so caught webhooks survive restarts, upgrades, and container rebuilds,
- sets `restart: unless-stopped`, so it comes back up after a server reboot.

Check it's healthy:

```bash
docker compose ps                  # STATUS should show (healthy)
docker compose logs -f             # structured JSON logs, one line per pipeline stage
curl http://localhost:8090/api/status
```

### Update to a new version

```bash
git pull
docker compose up -d --build       # rebuilds and replaces the container; data volume is untouched
```

### Backup and restore

The entire state is one SQLite database on the `webhook-data` volume:

```bash
# backup
docker run --rm -v webhook-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/webhook-data.tar.gz -C /data .

# restore
docker run --rm -v webhook-data:/data -v "$PWD":/backup alpine \
  tar xzf /backup/webhook-data.tar.gz -C /data
```

### Without compose

```bash
docker build -t webhook-catcher .
docker run -d --name webhook-catcher --restart unless-stopped \
  -p 8090:8090 -v webhook-data:/data webhook-catcher
```

### Exposing it to the internet

Webhook senders (Stripe, GitHub, …) need to reach the container from the internet. Don't publish port 8090 directly — put a reverse proxy with TLS in front (Caddy, Traefik, or nginx + certbot). Caddy is the least work:

```
# Caddyfile — automatic HTTPS via Let's Encrypt
hooks.designinlight.dev {
    reverse_proxy webhook-catcher:8090
}
```

The app is proxy-aware: it trusts `X-Forwarded-*` headers (`trustProxy`), so client IPs are logged correctly and the session cookie is automatically marked `Secure` when the request arrived over HTTPS. Catch URLs shown in the dashboard use the browser's origin, so they read `https://hooks.designinlight.dev/hooks/<slug>` automatically.

Two cautions before going public:

- **Set a strong `ADMIN_PASSWORD`.** The dashboard and admin API are behind the login page; the catch endpoints stay public by design.
- Use per-route **signing secrets** for senders that support HMAC signatures, so strangers can't POST fake events to your catch URLs.

## Configuration

| Env var    | Default     | Purpose                          |
|------------|-------------|----------------------------------|
| `PORT`     | `8090`      | HTTP port                        |
| `HOST`     | `127.0.0.1` | Bind address (`0.0.0.0` in Docker) |
| `DATA_DIR` | `./data`    | Where the SQLite file lives      |
| `ADMIN_PASSWORD` | *generated* | Password for the `admin` user. If unset, one is generated on first start and printed in the logs |
| `UPTIME_KUMA_PUSH_URL` | *unset* | Uptime Kuma push-monitor URL; when set, the app pings it every minute |

The dashboard, admin API, and event stream require a login (7-day session cookie). Only the catch endpoints (`/hooks/*`) and the login flow are public — webhook senders can't authenticate. Users are managed on the **Users** page (or `/api/users`): add users, change passwords, delete users (deleting a user revokes their sessions immediately; you can't delete yourself or the last user).

Optional per-route signing secret enables HMAC-SHA256 verification of incoming webhooks (`x-hub-signature-256` / `x-signature` / `x-webhook-signature`, GitHub-style `sha256=` prefix supported).

## Monitoring with Uptime Kuma

Two options, use either (or both):

- **HTTP(s) monitor** — point Kuma at `https://hooks.designinlight.dev/health`. It's public (no login), exposes no route/event data, and returns `200 {"status":"ok"}` while the delivery worker is alive, `503 {"status":"degraded"}` if it stalls.
- **Push monitor** — create a Push monitor in Kuma, paste its URL into the `UPTIME_KUMA_PUSH_URL=` line in `docker-compose.yml`, and redeploy (`docker compose up -d`). The app then pings Kuma every minute; if it dies entirely, the pushes stop and Kuma alerts — this catches failure modes an HTTP probe can't reach (e.g. network path down).

## Scripts

```bash
npm run dev     # dev server with reload
npm test        # unit tests (transform engine, retry schedule)
npm run build   # compile to dist/
npm start       # run compiled build
```

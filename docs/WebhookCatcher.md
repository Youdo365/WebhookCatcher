# WebhookCatcher

Self-hosted webhook relay in a single Docker container: catch webhooks, inspect them live, transform the payload, and forward it to another webhook — with delivery retries, replay, manual triggering, a status page, user management, and full per-event logging.

**Source code:** [github.com/Youdo365/WebhookCatcher](https://github.com/Youdo365/WebhookCatcher)
**Production:** [hooks.designinlight.dev](https://hooks.designinlight.dev)

## What it does

WebhookCatcher sits between a webhook **sender** (a shop, Git host, payment provider, …) and a **destination** (Slack, another API, an automation platform). It solves four problems in one small app:

1. **Never lose a webhook** — every incoming request is stored durably before the sender gets its `200 OK`.
2. **See what senders actually send** — a live inbox shows each webhook the moment it arrives, with full headers and payload.
3. **Reshape the payload** — a per-route JSONata transform converts the sender's format into whatever the destination expects.
4. **Deliver reliably** — forwarding happens asynchronously with automatic retries and a dead-letter state, so a slow or briefly-down destination never causes data loss.

## Architecture

```
Sender ──POST /hooks/<slug>──▶ Ingest ──▶ SQLite ──▶ Delivery worker ──POST──▶ Destination
                                 │ 200 OK             (transform + retries:
                                 ▼                     30s → 2m → 10m → 1h → 6h → dead)
                           Live inbox (SSE)
```

Key design decisions:

- **Receiving is decoupled from forwarding.** The sender is acknowledged immediately after the event is stored; transformation and delivery run in a background worker. Slow destinations never make the sender time out.
- **Transforms are pure functions.** A transform is a JSONata expression evaluated over `{ headers, body, route }` with no side effects — so the same code powers live delivery, the preview editor, and replays, and every mapping is unit-testable.
- **One container, one file.** Web server, delivery worker, and SQLite database run in a single Node.js process. No external queue or database server to operate. The "queue" is a table scan for due events every 3 seconds.

### Event lifecycle

| Status | Meaning |
|---|---|
| `received` | Stored, waiting for the worker to transform and deliver |
| `delivered` | Destination answered 2xx (or the route has no destination — catch-only) |
| `failed` | A delivery attempt failed; a retry is scheduled with exponential backoff |
| `dead` | All 6 attempts exhausted, or the transform itself errored (permanent) — needs a replay after fixing |

Every delivery attempt is recorded with its HTTP status code, response body, and error, and shown as a timeline on the event's detail page.

## Routes

A **route** is one webhook pipeline. It defines:

| Field | Purpose |
|---|---|
| Slug | The catch URL becomes `https://<host>/hooks/<slug>` |
| Destination URL | Where the transformed payload is POSTed. Leave empty for a catch-only route (inspect without forwarding) |
| Transform | JSONata expression mapping the incoming payload to the outgoing one (default `body` = pass through) |
| Destination headers | Extra headers for the outgoing request, e.g. an API key |
| Signing secret | Optional. Enables HMAC-SHA256 verification of incoming webhooks (GitHub/Stripe style, `x-hub-signature-256` / `x-signature` / `x-webhook-signature`) — requests with a bad signature are rejected with 401 |

### Transform examples

The transform input is always `{ headers, body, route }`. Examples:

Pass the body through unchanged:
```
body
```

Reshape fields, do arithmetic, build strings:
```
{
  "text": "New order from " & body.user.name,
  "amount": body.total / 100,
  "source": headers.`x-source`
}
```

Reshape arrays:
```
{ "items": body.line_items.{ "sku": id, "qty": quantity } }
```

The route editor has a live **preview**: paste a sample payload, click *Preview transform*, and see the exact output before saving. See [jsonata.org](https://jsonata.org) for the full expression language.

## Dashboard

Served by the container itself (production: `https://hooks.designinlight.dev`). Pages:

- **Inbox** — every caught webhook, newest first, updating live as they arrive (Server-Sent Events; the green dot in the header shows the live connection). Click an event for the full detail: incoming payload and headers, transformed output, and the delivery timeline with every attempt.
- **Routes** — create and edit routes, copy catch URLs, open the trigger form.
- **Status** — health per route: green (all delivered), amber (retries pending), red (dead-lettered events), plus 24-hour received/delivered counts, success rate, and the delivery-worker heartbeat.
- **Users** — manage who can sign in (see below).
- **Help** — a built-in explanation of the pipeline, transforms, statuses, and monitoring, written for end users.

### Replay and manual trigger

- **Replay** (button on any event) re-runs that event's stored payload through the pipeline as a fresh event — invaluable after fixing a transform or a destination outage.
- **Trigger** (button on any route) fires the pipeline with a payload you write by hand, pre-filled from the route's most recent event. Because triggers ride the normal pipeline — transform, delivery, retries — this is the end-to-end test button for a new route. Triggered and replayed events are labeled `manual` / `replay` in the inbox so they're distinguishable from real traffic.

## API

Everything the dashboard does is available as JSON endpoints:

| Method & path | Purpose |
|---|---|
| `POST /hooks/:slug` | The catch endpoint senders POST to (public) |
| `GET /health` | Public health check — `200` while healthy, `503` if the worker stalls |
| `GET /api/routes` · `POST /api/routes` | List / create routes |
| `GET` / `PUT` / `DELETE /api/routes/:id` | Read / update / delete a route |
| `POST /api/routes/:id/trigger` | Fire the pipeline with `{ "payload": … }` |
| `GET /api/events?route_id=&limit=` | List caught events |
| `GET /api/events/:id` | Event detail incl. all delivery attempts |
| `POST /api/events/:id/replay` | Replay a stored event |
| `POST /api/preview` | Run `{ "spec": …, "body": … }` through a transform without saving anything |
| `GET /api/status` | Route health + worker heartbeat (JSON behind the Status page) |
| `GET /api/events/stream` | Server-Sent Events stream of incoming/updated events |

## Authentication and users

The dashboard, admin API, and live event stream sit behind a **login page** (`/login`) with per-user accounts. Only the catch endpoints (`/hooks/*`) and `/health` are public — webhook senders can't authenticate.

- On first start the **admin** user is created with the password from the `ADMIN_PASSWORD` environment variable (set in `docker-compose.yml`; re-applied on every start, so it doubles as password recovery).
- **Users page** in the dashboard: add users (username + password), change any user's password, delete users. Deleting a user revokes their sessions immediately. You can't delete your own account or the last remaining user.
- Passwords are stored as scrypt hashes; a successful login sets a signed, HTTP-only session cookie valid for 7 days (marked `Secure` over HTTPS). The header shows who is signed in.
- Failed logins are delayed and logged (`auth.login_failed`); user changes are logged with who made them.

| Endpoint | Purpose |
|---|---|
| `POST /api/login` · `POST /api/logout` · `GET /api/me` | Session management |
| `GET /api/users` · `POST /api/users` | List / add users |
| `PUT /api/users/:id/password` · `DELETE /api/users/:id` | Change password / remove user |

## Logging

Two layers, correlated by event id:

1. **Structured JSON logs** (pino) — one line per stage: `event.received`, `event.triggered`, `delivery.success`, `delivery.retry_scheduled`, `delivery.dead`, with route, attempt number, status code, and error. View with `docker compose logs -f`.
2. **Per-event timeline in the UI** — every delivery attempt is stored in the database and rendered on the event detail page, so debugging a failed delivery never requires reading server logs.

## Deploying with Docker

The app ships as a single container: web server, delivery worker, and SQLite in one process. Multi-stage build on `node:24-alpine` (no native modules — SQLite is built into Node), runs as the unprivileged `node` user, container healthcheck on `/health`.

### Deploy on a server

```bash
git clone https://github.com/Youdo365/WebhookCatcher.git
cd WebhookCatcher
# edit docker-compose.yml: set ADMIN_PASSWORD (and optionally UPTIME_KUMA_PUSH_URL)
docker compose up -d --build
```

Dashboard: `http://<server>:8090` — catch URLs: `http://<server>:8090/hooks/<slug>`. The compose file publishes port 8090, stores the SQLite database on the named volume `webhook-data` (survives restarts and upgrades), and sets `restart: unless-stopped` so it comes back after a reboot.

Verify:

```bash
docker compose ps        # STATUS should show (healthy)
docker compose logs -f   # structured JSON logs per pipeline stage
curl http://localhost:8090/health
```

### Configuration

All settings live in `docker-compose.yml`:

| Env var | Default | Purpose |
|---|---|---|
| `ADMIN_PASSWORD` | `change-me` | Password for the `admin` user — change it before deploying |
| `UPTIME_KUMA_PUSH_URL` | *empty* | Uptime Kuma push-monitor URL — pinged every minute when set |
| `PORT` / `HOST` / `DATA_DIR` | `8090` / `0.0.0.0` / `/data` | Set correctly for Docker in the image; no need to touch |

### Update to a new version

```bash
git pull
docker compose up -d --build   # data volume is untouched
```

### Backup and restore

All state is one SQLite database on the `webhook-data` volume:

```bash
# backup
docker run --rm -v webhook-data:/data -v "$PWD":/backup alpine tar czf /backup/webhook-data.tar.gz -C /data .
# restore
docker run --rm -v webhook-data:/data -v "$PWD":/backup alpine tar xzf /backup/webhook-data.tar.gz -C /data
```

### Exposing it to the internet

Webhook senders need to reach the container from the internet. Don't publish port 8090 directly — put a reverse proxy with automatic TLS in front (Caddy is the least work):

```
hooks.designinlight.dev {
    reverse_proxy webhook-catcher:8090
}
```

The app trusts `X-Forwarded-*` headers from the proxy, logs real client IPs, and marks the session cookie `Secure` on HTTPS. Catch URLs become `https://hooks.designinlight.dev/hooks/<slug>`.

Two cautions before going public:

- **Set a strong `ADMIN_PASSWORD`.** The dashboard and admin API are behind the login page; the catch endpoints stay public by design.
- Use per-route **signing secrets** for senders that support HMAC signatures, so strangers can't POST fake events to your catch URLs.

## Monitoring (Uptime Kuma)

- **HTTP(s) monitor**: point Kuma at `https://hooks.designinlight.dev/health` — public, no login needed, no data exposed. Returns `200 {"status":"ok"}` while the delivery worker is alive, `503` when it stalls — catching both "app down" and "app up but not delivering".
- **Push monitor**: paste the push URL Kuma generates into the `UPTIME_KUMA_PUSH_URL=` line in `docker-compose.yml` and redeploy; the app pings it every minute. If the app dies, pushes stop and Kuma alerts.

## Development

To work on the code you need Node.js ≥ 22.13 (no other services — SQLite is built into Node):

```bash
npm install
npm test        # unit tests: transform engine, retry schedule, auth/users
npm run dev     # local dev server on http://127.0.0.1:8090
```

Locally, `ADMIN_PASSWORD` is optional — without it a password is generated on first start and printed once in the logs. Local data lands in `./data/`.

### Codebase map

```
src/
├── server.ts            Fastify wiring, auth guard, static dashboard, worker startup
├── worker.ts            Delivery loop (3s poll + instant wake), heartbeat, Kuma push
├── core/
│   ├── transform.ts     Pure JSONata transform + spec validation
│   ├── deliver.ts       Transform → POST → record attempt → retry/dead
│   ├── retry.ts         Backoff schedule
│   ├── trigger.ts       Manual trigger / replay (shared pipeline entry)
│   ├── verify.ts        HMAC-SHA256 signature check of incoming webhooks
│   ├── auth.ts          Password hashing, session tokens, first-start setup
│   └── bus.ts           In-process pub/sub feeding the SSE stream
├── routes/              ingest, admin API, auth, users, status/health, SSE stream
└── db/                  Schema + typed SQLite queries (node:sqlite)
public/                  Dashboard incl. login page (vanilla JS, no build step)
test/                    Transform, retry, and auth unit tests
```

## Roadmap

- Event retention/cleanup policy
- Per-route delivery rate limiting

# WebhookCatcher

Catch webhooks, inspect them live, transform the payload, and forward it to another webhook — with delivery retries, replay, manual triggering, a status page, and full per-event logging.

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
- **One process, one file.** Web server, delivery worker, and SQLite database run in a single Node.js process. No external queue or database server to operate. The "queue" is a table scan for due events every 3 seconds.

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
| Slug | The catch URL becomes `http://<host>:8090/hooks/<slug>` |
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

Runs at `http://127.0.0.1:8090`.

- **Inbox** — every caught webhook, newest first, updating live as they arrive (Server-Sent Events; the green dot in the header shows the live connection). Click an event for the full detail: incoming payload and headers, transformed output, and the delivery timeline with every attempt.
- **Routes** — create and edit routes, copy catch URLs, open the trigger form.
- **Status** — health per route: green (all delivered), amber (retries pending), red (dead-lettered events), plus 24-hour received/delivered counts, success rate, and the delivery-worker heartbeat.

### Replay and manual trigger

- **Replay** (button on any event) re-runs that event's stored payload through the pipeline as a fresh event — invaluable after fixing a transform or a destination outage.
- **Trigger** (button on any route) fires the pipeline with a payload you write by hand, pre-filled from the route's most recent event. Because triggers ride the normal pipeline — transform, delivery, retries — this is the end-to-end test button for a new route. Triggered and replayed events are labeled `manual` / `replay` in the inbox so they're distinguishable from real traffic.

## API

Everything the dashboard does is available as JSON endpoints:

| Method & path | Purpose |
|---|---|
| `POST /hooks/:slug` | The catch endpoint senders POST to |
| `GET /api/routes` · `POST /api/routes` | List / create routes |
| `GET` / `PUT` / `DELETE /api/routes/:id` | Read / update / delete a route |
| `POST /api/routes/:id/trigger` | Fire the pipeline with `{ "payload": … }` |
| `GET /api/events?route_id=&limit=` | List caught events |
| `GET /api/events/:id` | Event detail incl. all delivery attempts |
| `POST /api/events/:id/replay` | Replay a stored event |
| `POST /api/preview` | Run `{ "spec": …, "body": … }` through a transform without saving anything |
| `GET /api/status` | Route health + worker heartbeat (JSON behind the Status page) |
| `GET /api/events/stream` | Server-Sent Events stream of incoming/updated events |

## Logging

Two layers, correlated by event id:

1. **Structured JSON logs** (pino) — one line per stage: `event.received`, `event.triggered`, `delivery.success`, `delivery.retry_scheduled`, `delivery.dead`, with route, attempt number, status code, and error. Pretty-printed in the terminal during development.
2. **Per-event timeline in the UI** — every delivery attempt is stored in the database and rendered on the event detail page, so debugging a failed delivery never requires reading server logs.

## Running it

```bash
npm install
npm run dev        # development, auto-reload — http://127.0.0.1:8090
npm test           # unit tests (transform engine, retry schedule)
npm run build && npm start   # production build
```

Requirements: Node.js ≥ 22.13 (SQLite is built into Node — no other database or service needed).

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `8090` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address — set `0.0.0.0` to accept non-local traffic (required in Docker) |
| `DATA_DIR` | `./data` | Directory for the SQLite database file |

**Reachability:** `127.0.0.1` only accepts webhooks from the same machine. To receive webhooks from the internet during development, use a tunnel (e.g. `ngrok http 8090`), or deploy the Docker container on a server.

### Docker

```bash
docker compose up -d
```

Multi-stage build on `node:24-alpine` — no native modules, single container, SQLite data persisted on the `/data` volume, healthcheck on `/api/status`. The container sets `HOST=0.0.0.0` so it accepts external traffic; put a reverse proxy with TLS in front of it for internet exposure.

## Codebase map

```
src/
├── server.ts            Fastify wiring, static dashboard, worker startup
├── worker.ts            Delivery loop (3s poll + instant wake on ingest), heartbeat
├── core/
│   ├── transform.ts     Pure JSONata transform + spec validation
│   ├── deliver.ts       Transform → POST → record attempt → retry/dead
│   ├── retry.ts         Backoff schedule
│   ├── trigger.ts       Manual trigger / replay (shared pipeline entry)
│   ├── verify.ts        HMAC-SHA256 signature check
│   └── bus.ts           In-process pub/sub feeding the SSE stream
├── routes/              ingest, admin API, status, SSE stream
└── db/                  Schema + typed SQLite queries (node:sqlite)
public/                  Dashboard (vanilla JS, no build step)
test/                    Transform + retry unit tests
```

## Roadmap

- Auth on the dashboard/admin API before internet exposure
- Event retention/cleanup policy
- Per-route delivery rate limiting

# Webhook Catcher

Catch webhooks, inspect them live, transform the payload with [JSONata](https://jsonata.org), and forward it to another webhook — with delivery retries, replay, manual triggering, a status page, and full per-event logging.

## Quick start

```bash
npm install
npm run dev        # http://127.0.0.1:8090
```

1. Open the dashboard → **Routes** → **New route**. Give it a slug (e.g. `orders`), optionally a destination URL and a JSONata transform.
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

## Configuration

| Env var    | Default     | Purpose                          |
|------------|-------------|----------------------------------|
| `PORT`     | `8090`      | HTTP port                        |
| `HOST`     | `127.0.0.1` | Bind address (`0.0.0.0` in Docker) |
| `DATA_DIR` | `./data`    | Where the SQLite file lives      |

Optional per-route signing secret enables HMAC-SHA256 verification of incoming webhooks (`x-hub-signature-256` / `x-signature` / `x-webhook-signature`, GitHub-style `sha256=` prefix supported).

## Scripts

```bash
npm run dev     # dev server with reload
npm test        # unit tests (transform engine, retry schedule)
npm run build   # compile to dist/
npm start       # run compiled build
```

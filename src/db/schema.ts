export const SCHEMA = `
CREATE TABLE IF NOT EXISTS routes (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  slug                TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  signing_secret      TEXT,
  transform_spec      TEXT NOT NULL DEFAULT 'body',
  destination_url     TEXT,
  destination_headers TEXT NOT NULL DEFAULT '{}',
  active              INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id         INTEGER NOT NULL REFERENCES routes(id),
  source           TEXT NOT NULL DEFAULT 'webhook',
  received_at      TEXT NOT NULL DEFAULT (datetime('now')),
  headers_json     TEXT NOT NULL,
  payload_json     TEXT NOT NULL,
  transformed_json TEXT,
  status           TEXT NOT NULL DEFAULT 'received',
  attempt_count    INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_events_due   ON events(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_events_route ON events(route_id, id DESC);

CREATE TABLE IF NOT EXISTS attempts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id      INTEGER NOT NULL REFERENCES events(id),
  attempt_no    INTEGER NOT NULL,
  at            TEXT NOT NULL DEFAULT (datetime('now')),
  status_code   INTEGER,
  response_body TEXT,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_attempts_event ON attempts(event_id);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

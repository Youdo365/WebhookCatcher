import type { FastifyBaseLogger as Logger } from 'fastify';
import * as repo from './db/repo.js';
import { deliverEvent } from './core/deliver.js';

const POLL_INTERVAL_MS = 3_000;
export const HEARTBEAT_KEY = 'worker_heartbeat';

// Optional Uptime Kuma push monitor: when set, the worker pings this URL
// every minute. If the app dies, pushes stop and Kuma raises an alert.
const KUMA_PUSH_URL = process.env.UPTIME_KUMA_PUSH_URL;
const KUMA_PUSH_INTERVAL_MS = 60_000;
let lastKumaPush = 0;

let log: Logger | null = null;
let running = false;
let timer: NodeJS.Timeout | null = null;

async function pushUptimeKuma(): Promise<void> {
  if (!KUMA_PUSH_URL || Date.now() - lastKumaPush < KUMA_PUSH_INTERVAL_MS) return;
  lastKumaPush = Date.now();
  try {
    const url = new URL(KUMA_PUSH_URL);
    url.searchParams.set('status', 'up');
    url.searchParams.set('msg', 'OK');
    await fetch(url, { signal: AbortSignal.timeout(5_000) });
  } catch (e) {
    log?.warn({ err: e instanceof Error ? e.message : String(e) }, 'worker.kuma_push_failed');
  }
}

async function tick(): Promise<void> {
  if (running || !log) return;
  running = true;
  try {
    repo.setMeta(HEARTBEAT_KEY, String(Date.now()));
    const due = repo.dueEvents(Date.now());
    for (const event of due) {
      await deliverEvent(event.id, log);
    }
    await pushUptimeKuma();
  } catch (e) {
    log.error({ err: e instanceof Error ? e.message : String(e) }, 'worker.tick_failed');
  } finally {
    running = false;
  }
}

/** Nudge the worker to process due events immediately (e.g. right after ingest). */
export function wake(): void {
  void tick();
}

export function startWorker(logger: Logger): void {
  log = logger.child({ component: 'worker' });
  timer = setInterval(tick, POLL_INTERVAL_MS);
  timer.unref();
  log.info({ pollIntervalMs: POLL_INTERVAL_MS }, 'worker.started');
  void tick();
}

export function stopWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

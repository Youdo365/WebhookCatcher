import type { FastifyBaseLogger as Logger } from 'fastify';
import * as repo from './db/repo.js';
import { deliverEvent } from './core/deliver.js';

const POLL_INTERVAL_MS = 3_000;
export const HEARTBEAT_KEY = 'worker_heartbeat';

let log: Logger | null = null;
let running = false;
let timer: NodeJS.Timeout | null = null;

async function tick(): Promise<void> {
  if (running || !log) return;
  running = true;
  try {
    repo.setMeta(HEARTBEAT_KEY, String(Date.now()));
    const due = repo.dueEvents(Date.now());
    for (const event of due) {
      await deliverEvent(event.id, log);
    }
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

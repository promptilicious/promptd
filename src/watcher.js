import fsp from 'node:fs/promises';
import path from 'node:path';
import { bus, emit } from './events.js';
import { CRONS_DIR } from './paths.js';
import { cronService } from './cronService.js';

const INTERVAL_MS = Number(process.env.WATCH_INTERVAL_MS ?? 3000);

// Only these fields make a cron a different cron. Run bookkeeping (lastRunAt and
// friends) is rewritten after every run, and must not read as an external edit.
const CONFIG_FIELDS = ['name', 'description', 'cron', 'workingDirectory', 'model', 'prompt', 'isActive'];

function fingerprint(cron) {
  return JSON.stringify(CONFIG_FIELDS.map((field) => cron[field] ?? null));
}

/**
 * Polls the crons folder so hand-edited files are picked up: a new file gets
 * scheduled, an edited one rescheduled, a deleted one unscheduled. A file that
 * will not parse keeps its last good schedule and is reported, because otherwise
 * it vanishes from the UI while still firing.
 */
class CronFileWatcher {
  constructor(intervalMs = INTERVAL_MS) {
    this.intervalMs = intervalMs;
    /** @type {Map<string, {name: string, fingerprint: string}>} file id -> config state */
    this.snapshot = new Map();
    /** @type {Map<string, string>} file id -> parse error, for files currently unreadable */
    this.broken = new Map();
    this.timer = null;
    this.busy = false;
  }

  /** Reads every cron file. Keyed by filename, which is the thing that appears and vanishes. */
  async readState(previous = this.snapshot) {
    const state = new Map();
    const broken = new Map();
    let files = [];
    try {
      files = await fsp.readdir(CRONS_DIR);
    } catch {
      return { state, broken };
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const id = file.replace(/\.json$/, '');
      try {
        const cron = JSON.parse(await fsp.readFile(path.join(CRONS_DIR, file), 'utf8'));
        state.set(id, { name: cron.name ?? id, fingerprint: fingerprint(cron) });
      } catch (err) {
        // Half-written or hand-edited into invalid JSON. Carry the last good state
        // forward rather than reporting a delete followed by an add.
        broken.set(id, err.message);
        const prior = previous.get(id);
        if (prior) state.set(id, prior);
      }
    }
    return { state, broken };
  }

  async start() {
    if (this.intervalMs <= 0) {
      console.log('[watch] disabled (WATCH_INTERVAL_MS=0)');
      return;
    }
    const initial = await this.readState(new Map());
    this.snapshot = initial.state;
    this.broken = initial.broken;
    this.timer = setInterval(() => {
      this.scan().catch((err) => console.error(`[watch] scan failed: ${err.message}`));
    }, this.intervalMs);
    this.timer.unref?.();
    // Writes made through the API already reloaded the service and told the UI,
    // so absorb them silently instead of announcing them a second time.
    bus.on('event', (event) => {
      if (event.type === 'crons:changed') this.resync().catch(() => {});
    });
    console.log(`[watch] watching ${CRONS_DIR} every ${this.intervalMs}ms`);
  }

  /** Accepts the folder's current state as the baseline without reporting anything. */
  async resync() {
    if (this.busy) return;
    const next = await this.readState();
    this.snapshot = next.state;
    this.broken = next.broken;
  }

  async scan() {
    if (this.busy) return null;
    this.busy = true;
    try {
      const { state: next, broken } = await this.readState();
      const added = [];
      const updated = [];
      const removed = [];

      // A file that just became readable again is reported as repaired, not as an edit,
      // so each file produces one message per scan.
      const repairedIds = new Set([...this.broken.keys()].filter((id) => !broken.has(id) && next.has(id)));

      for (const [id, entry] of next) {
        // A file that will not parse reports as broken, never as an edit.
        if (broken.has(id) || repairedIds.has(id)) continue;
        const prior = this.snapshot.get(id);
        if (!prior) added.push(entry.name);
        else if (prior.fingerprint !== entry.fingerprint) updated.push(entry.name);
      }
      for (const [id, entry] of this.snapshot) {
        if (!next.has(id)) removed.push(entry.name);
      }

      const nowBroken = [...broken.keys()]
        .filter((id) => !this.broken.has(id))
        .map((id) => ({ file: `${id}.json`, error: broken.get(id) }));
      const repaired = [...repairedIds].map((id) => next.get(id).name);

      const changed =
        added.length || updated.length || removed.length || nowBroken.length || repaired.length;
      if (!changed) return null;

      this.snapshot = next;
      this.broken = broken;

      const summary = [
        added.length && `added ${added.length}`,
        updated.length && `updated ${updated.length}`,
        removed.length && `removed ${removed.length}`,
        nowBroken.length && `unreadable ${nowBroken.length}`,
        repaired.length && `repaired ${repaired.length}`,
      ]
        .filter(Boolean)
        .join(', ');
      console.log(`[watch] cron folder changed on disk (${summary})`);

      // Only a valid config change needs the schedules rebuilt.
      if (added.length || updated.length || removed.length || repaired.length) {
        await cronService.reload();
      }
      emit('crons:files-changed', { added, updated, removed, broken: nowBroken, repaired });
      return { added, updated, removed, broken: nowBroken, repaired };
    } finally {
      this.busy = false;
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const cronFileWatcher = new CronFileWatcher();

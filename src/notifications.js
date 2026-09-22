import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { bus, emit } from './events.js';
import { ROOT } from './paths.js';

/**
 * Every notice the server produces, kept so it can be read later.
 *
 * The page already toasts these as they happen, but a toast is gone in a few
 * seconds and nobody watches a dashboard all day. This writes the same events
 * down — one small JSON file each, under the storage root — so the answer to
 * "what did I miss overnight" is a scroll rather than a log dig.
 *
 * Read state is the point of the whole thing, so most kinds arrive already
 * read: a cron that ran and succeeded is not news. What is left unread is what
 * a person would want to have been told — a run that failed, a trigger held for
 * usage, anything the updater did.
 */
export const NOTIFICATIONS_DIR = path.join(ROOT, 'notifications');

/** Past this the oldest are deleted as new ones land, file and all. */
export const MAX_NOTIFICATIONS = 5000;

/** One screenful for the drawer's infinite scroll. */
export const PAGE_SIZE = 20;

/** Files are read this many at a time at startup, so 5000 of them do not open 5000 handles. */
const LOAD_CONCURRENCY = 64;

/** `2026-09-15T22-31-33.059Z-4f3c21aa.json`, which sorts chronologically. */
function fileName(record) {
  return `${record.at.replace(/:/g, '-')}-${record.id.slice(0, 8)}.json`;
}

/**
 * What was running when a machine alert fired, and how far into its run each
 * was — the other half of the answer to "why was the CPU pinned".
 *
 * Three names at most. A machine busy enough to alert may have several runs on
 * it, and a notification is a line to read, not a table.
 */
function runningSummary(running = []) {
  if (!running.length) return 'No crons were running.';
  const named = running.slice(0, 3).map((run) => {
    const ms = Date.now() - Date.parse(run.startedAt);
    if (!Number.isFinite(ms) || ms < 0) return `"${run.name}"`;
    const minutes = Math.floor(ms / 60000);
    return `"${run.name}" (${minutes ? `${minutes}m` : `${Math.round(ms / 1000)}s`} in)`;
  });
  const rest = running.length - named.length;
  return `Running: ${named.join(', ')}${rest ? ` and ${rest} more` : ''}.`;
}

/** The limits a held trigger is waiting on, e.g. "Session, Weekly". */
function blockerNames(event) {
  return (event?.reasons ?? []).map((reason) => reason.label).join(', ');
}

/**
 * What one event is worth recording as, or null for the ones that are signals
 * rather than news — a redraw hint, a stats sample, this module's own events.
 *
 * Returns one notification or several: a batch of file changes is several
 * separate things happening, and reads better as one line each.
 *
 * The wording matches the toasts the page shows for the same events. Those are
 * written in the client and these on the server, so the two are kept in step by
 * hand; a difference in wording is a bug, not a feature.
 */
function describe(event) {
  // jobKind, not kind: `kind` on a notification is what sort of notice it is,
  // and this is what sort of thing it happened to.
  const cron = { cronId: event.cronId ?? null, cronName: event.cronName ?? null, jobKind: event.kind ?? 'cron' };
  // A one-time execution names itself as one, so a line in the drawer is not
  // read as a cron that has started misbehaving.
  const name = event.kind === 'execution' ? `one-time "${event.cronName}"` : `"${event.cronName}"`;
  switch (event.type) {
    case 'run:started':
      return { kind: 'run', read: true, message: `${name} started`, ...cron };
    case 'run:finished': {
      const succeeded = event.status === 'succeeded';
      return {
        kind: succeeded ? 'run' : 'run-failed',
        // A run that did not succeed is the one run event worth finding later.
        read: succeeded,
        // An interrupted run never wrote a footer, so it has no duration to
        // report and must not claim one.
        message: Number.isFinite(event.seconds)
          ? `${name} ${event.status} in ${event.seconds}s`
          : `${name} ${event.status}`,
        ...cron,
      };
    }
    case 'run:stopping':
      return { kind: 'run', read: true, message: `${name} is stopping`, ...cron };
    case 'run:skipped':
      return {
        kind: 'run',
        read: true,
        message: event.reason ? `${name} skipped: ${event.reason}` : `${name} was still running; trigger skipped`,
        ...cron,
      };
    case 'run:dropped':
      return {
        kind: 'pause',
        // The pause that dropped it was asked for, so this is a consequence
        // rather than a surprise.
        read: true,
        message: `${name} trigger dropped: ${event.reason}`,
        ...cron,
      };
    case 'run:delayed':
      return {
        kind: 'delayed',
        read: false,
        // A queued trigger says where it stands rather than what it is waiting
        // on: the limit is the same for every one of them, the place is not.
        message:
          event.hold === 'concurrency'
            ? `${name} is queued at position ${event.position + 1} of ${event.queueLength}, behind ${event.runningCount} running job${event.runningCount === 1 ? '' : 's'}`
            : `${name} is waiting on ${blockerNames(event)}`,
        ...cron,
      };
    case 'run:released':
      return {
        kind: 'delayed',
        read: true,
        message: event.ran
          ? event.hold === 'concurrency'
            ? `${name} reached the front of the queue, starting now`
            : `${name} usage cleared, starting now`
          : `${name} waiting trigger dropped: ${event.reason}`,
        ...cron,
      };
    case 'execution:overdue':
      return {
        kind: 'delayed',
        // A trigger that was missed and is being made up is exactly the kind of
        // thing you want to find in the morning.
        read: false,
        message: `${name} missed its trigger by ${event.lateBy}; running now`,
        ...cron,
      };
    case 'pause:changed':
      return event.paused
        ? { kind: 'pause', read: true, message: `Everything paused ${event.label}` }
        : {
            kind: 'pause',
            read: true,
            message: event.resumedFrom
              ? `Schedules resumed after the "${event.resumedFrom}" pause (${event.reason})`
              : 'Schedules resumed',
          };
    case 'update:availability':
      // Only the arrival of an update is news; its disappearance is an update
      // that got applied, which the launch already recorded.
      return event.updateAvailable
        ? {
            kind: 'update',
            read: false,
            message: `Update available: ${event.updateBehind} commit${event.updateBehind === 1 ? '' : 's'} behind origin/main`,
          }
        : null;
    case 'update:waiting':
      return {
        kind: 'update',
        read: false,
        message: `Update is holding schedules, waiting on ${event.runningCount} run(s) to finish`,
      };
    case 'update:launched':
      return { kind: 'update', read: false, message: `Update started from ${event.from ?? 'the current commit'}; the service will restart` };
    case 'update:abandoned':
      return { kind: 'update', read: false, message: `Update gave up waiting on ${event.runningCount} run(s); schedules resumed` };
    case 'update:failed':
      return { kind: 'update', read: false, message: `Update script failed (exit ${event.code}); schedules resumed` };
    case 'system:alert':
      return {
        kind: 'system',
        // The whole reason the machine stats are watched at all.
        read: false,
        message: `${event.label}: ${event.summary}. ${runningSummary(event.running)}`,
      };
    case 'crons:files-changed': {
      const out = [];
      for (const cronName of event.added ?? []) out.push({ kind: 'cron', read: true, message: `Cron file added: "${cronName}", now scheduled` });
      for (const cronName of event.updated ?? []) out.push({ kind: 'cron', read: true, message: `Cron file updated: "${cronName}", rescheduled` });
      for (const cronName of event.removed ?? []) out.push({ kind: 'cron', read: true, message: `Cron file deleted: "${cronName}", unscheduled` });
      for (const cronName of event.repaired ?? []) out.push({ kind: 'cron', read: true, message: `Cron file fixed: "${cronName}", rescheduled` });
      // A file that will not parse is running its last saved version, which is
      // worth noticing before it drifts further from what is on disk.
      for (const item of event.broken ?? []) {
        out.push({ kind: 'cron-broken', read: false, message: `${item.file} is not valid JSON; still running its last saved version` });
      }
      return out;
    }
    default:
      return null;
  }
}

class NotificationCenter {
  constructor() {
    /** Newest first, which is the order everything reads them in. @type {Array<object>} */
    this.items = [];
    /** The startup read, so the API can wait for it without blocking the server. @type {Promise|null} */
    this.ready = null;
    this.listening = false;
  }

  /**
   * Subscribes immediately and reads the folder in the background.
   *
   * Events arriving during that read are already in `items`, so the records
   * coming off disk are appended under them rather than replacing them: they
   * are older by definition.
   */
  start() {
    if (!this.listening) {
      bus.on('event', (event) => {
        try {
          this.record(event);
        } catch (err) {
          console.error(`[notifications] could not record ${event?.type}: ${err.message}`);
        }
      });
      this.listening = true;
    }
    this.ready = this.load();
    return this.ready;
  }

  async load() {
    await fsp.mkdir(NOTIFICATIONS_DIR, { recursive: true }).catch(() => {});
    const names = (await fsp.readdir(NOTIFICATIONS_DIR).catch(() => []))
      .filter((name) => name.endsWith('.json'))
      .sort()
      .reverse();

    // Anything past the cap is deleted here rather than read. A prune
    // interrupted by a restart, or one whose delete lost a race with its own
    // write, leaves files behind; this is what stops them accumulating.
    for (const stale of names.splice(MAX_NOTIFICATIONS)) {
      await fsp.rm(path.join(NOTIFICATIONS_DIR, stale), { force: true }).catch(() => {});
    }

    const loaded = [];
    for (let index = 0; index < names.length; index += LOAD_CONCURRENCY) {
      const batch = await Promise.all(
        names.slice(index, index + LOAD_CONCURRENCY).map(async (name) => {
          const raw = await fsp.readFile(path.join(NOTIFICATIONS_DIR, name), 'utf8').catch(() => null);
          if (!raw) return null;
          try {
            const record = JSON.parse(raw);
            // A file with no timestamp cannot be ordered, so it is left on disk
            // and ignored rather than shown in the wrong place.
            return record?.id && record?.at ? { ...record, read: Boolean(record.read), file: name } : null;
          } catch {
            return null;
          }
        }),
      );
      for (const record of batch) if (record) loaded.push(record);
    }
    this.items = [...this.items, ...loaded];
    return this.items.length;
  }

  /** Turns one bus event into however many notifications it is worth. */
  record(event) {
    const described = describe(event);
    if (!described) return;
    for (const one of [].concat(described)) this.add(one);
  }

  /**
   * Adds one, announces it, and writes it down. The disk write is not waited
   * on: a notification that cannot be written is still worth showing, and the
   * event that produced it must not be held up by a filesystem.
   */
  add({ kind, message, read = true, cronId = null, cronName = null, jobKind = 'cron' }) {
    const record = {
      id: randomUUID(),
      at: new Date().toISOString(),
      kind,
      message,
      read: Boolean(read),
      cronId,
      cronName,
      // Which page the drawer's link should open: a cron's logs or an execution's.
      jobKind,
    };
    record.file = fileName(record);
    this.items.unshift(record);
    const pruned = this.items.length > MAX_NOTIFICATIONS ? this.items.splice(MAX_NOTIFICATIONS) : [];
    emit('notification:new', { notification: this.view(record), unread: this.unreadCount() });
    void this.persist(record);
    for (const old of pruned) void this.remove(old);
    return record;
  }

  /** Marks the given ids read, and answers with what is still unread. */
  async markRead(ids) {
    await this.ready;
    const wanted = new Set([].concat(ids ?? []));
    const changed = [];
    for (const record of this.items) {
      if (!record.read && wanted.has(record.id)) {
        record.read = true;
        changed.push(record);
      }
    }
    await Promise.all(changed.map((record) => this.persist(record)));
    const unread = this.unreadCount();
    // Other open tabs are showing the same badge, so the count travels.
    if (changed.length) emit('notification:read', { ids: changed.map((record) => record.id), unread });
    return { marked: changed.length, unread };
  }

  /**
   * One page, newest first. `before` is the id of the last one already shown,
   * which is a cursor rather than an offset on purpose: notifications arrive
   * while the list is open, and an offset would show one of them twice.
   */
  async page({ before = null, limit = PAGE_SIZE } = {}) {
    await this.ready;
    const size = Math.max(1, Math.min(100, Number(limit) || PAGE_SIZE));
    let start = 0;
    if (before) {
      const index = this.items.findIndex((record) => record.id === before);
      // A cursor that is no longer here — pruned, or from an older run — starts
      // again from the top rather than answering with nothing.
      start = index >= 0 ? index + 1 : 0;
    }
    const items = this.items.slice(start, start + size);
    return {
      items: items.map((record) => this.view(record)),
      // The cursor for the next page, and null when this was the last of them.
      nextBefore: start + size < this.items.length ? items.at(-1)?.id ?? null : null,
      unread: this.unreadCount(),
      total: this.items.length,
    };
  }

  /** The file name and the in-flight write are ours, not the reader's. */
  view(record) {
    const { file, writing, ...rest } = record;
    return rest;
  }

  unreadCount() {
    let count = 0;
    for (const record of this.items) if (!record.read) count += 1;
    return count;
  }

  /**
   * Writes one record, and remembers the write while it is in flight.
   *
   * A burst of notifications can prune a record before its own file has been
   * written, and a delete that lands first deletes nothing — the write then
   * recreates the file and it is there for good. `writing` is what `remove`
   * waits on so that cannot happen.
   */
  async persist(record) {
    const write = this.write(record);
    record.writing = write;
    await write;
    if (record.writing === write) record.writing = null;
  }

  async write(record) {
    try {
      await fsp.mkdir(NOTIFICATIONS_DIR, { recursive: true });
      const target = path.join(NOTIFICATIONS_DIR, record.file);
      const tmp = `${target}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, `${JSON.stringify(this.view(record), null, 2)}\n`, 'utf8');
      await fsp.rename(tmp, target);
    } catch (err) {
      console.error(`[notifications] could not write ${record.file}: ${err.message}`);
    }
  }

  async remove(record) {
    // Never delete ahead of the write that would put it back.
    await record.writing?.catch(() => {});
    await fsp.rm(path.join(NOTIFICATIONS_DIR, record.file), { force: true }).catch(() => {});
  }
}

export const notificationCenter = new NotificationCenter();

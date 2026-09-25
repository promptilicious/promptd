import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import type { NotificationTable } from './db.js';
import { bus, emit } from './events.js';
import type { RunningJobSummary } from './system.js';
import type { BusEvent, JobKind, UsageBlocker } from './types.js';

export interface NotificationRecord {
  id: string;
  at: string;
  kind: string;
  message: string;
  read: boolean;
  cronId: string | null;
  cronName: string | null;
  jobKind: JobKind;
  writing?: Promise<void> | null;
}

export type NotificationView = Omit<NotificationRecord, 'writing'>;

export interface NotificationPage {
  items: NotificationView[];
  nextBefore: string | null;
  unread: number;
  total: number;
}

interface NotificationDraft {
  kind: string;
  message: string;
  read?: boolean;
  cronId?: string | null;
  cronName?: string | null;
  jobKind?: JobKind;
}

type DescribableEvent = BusEvent & {
  cronId?: string | null;
  cronName?: string | null;
  kind?: JobKind;
  status?: string;
  seconds?: number;
  error?: string;
  reason?: string;
  hold?: 'concurrency' | 'usage';
  position?: number;
  queueLength?: number;
  runningCount?: number;
  ran?: boolean;
  lateBy?: string;
  paused?: boolean;
  label?: string;
  resumedFrom?: string | null;
  updateAvailable?: boolean;
  updateBehind?: number;
  from?: string | null;
  code?: number | null;
  summary?: string;
  running?: RunningJobSummary[];
  reasons?: UsageBlocker[];
};

/**
 * Every notice the server produces, kept so it can be read later.
 *
 * The page already toasts these as they happen, but a toast is gone in a few
 * seconds and nobody watches a dashboard all day. This writes the same events
 * down — one row each, in the database — so the answer to
 * "what did I miss overnight" is a scroll rather than a log dig.
 *
 * Read state is the point of the whole thing, so most kinds arrive already
 * read: a cron that ran and succeeded is not news. What is left unread is what
 * a person would want to have been told — a run that failed, a trigger held for
 * usage, anything the updater did.
 */
/** Past this the oldest are deleted as new ones land. */
export const MAX_NOTIFICATIONS = 5000;

/** One screenful for the drawer's infinite scroll. */
export const PAGE_SIZE = 20;

function toRow(record: NotificationRecord): NotificationTable {
  return {
    id: record.id,
    at: record.at,
    kind: record.kind,
    message: record.message,
    read: record.read ? 1 : 0,
    cronId: record.cronId,
    cronName: record.cronName,
    jobKind: record.jobKind,
  };
}

function fromRow(row: NotificationTable): NotificationRecord {
  return { ...row, read: Boolean(row.read), jobKind: row.jobKind === 'execution' ? 'execution' : 'cron' };
}

/**
 * What was running when a machine alert fired, and how far into its run each
 * was — the other half of the answer to "why was the CPU pinned".
 *
 * Three names at most. A machine busy enough to alert may have several runs on
 * it, and a notification is a line to read, not a table.
 */
function runningSummary(running: RunningJobSummary[] = []): string {
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
function blockerNames(event: DescribableEvent): string {
  return (event?.reasons ?? []).map((reason) => reason.label).join(', ');
}

/**
 * What one event is worth recording as, or null for the ones that are signals
 * rather than news — a redraw hint, a stats sample, this module's own events.
 *
 * The wording matches the toasts the page shows for the same events. Those are
 * written in the client and these on the server, so the two are kept in step by
 * hand; a difference in wording is a bug, not a feature.
 */
function describe(event: DescribableEvent): NotificationDraft | NotificationDraft[] | null {
  // jobKind, not kind: `kind` on a notification is what sort of notice it is,
  // and this is what sort of thing it happened to.
  const cron: Pick<NotificationDraft, 'cronId' | 'cronName' | 'jobKind'> = { cronId: event.cronId ?? null, cronName: event.cronName ?? null, jobKind: event.kind ?? 'cron' };
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
    // A run that could not set up or tear down its worktree may have gone
    // without the files it needed, or left a folder and branch behind.
    case 'worktree:include-failed':
      return { kind: 'worktree-failed', read: false, message: `${name} could not write .worktreeinclude: ${event.error}`, ...cron };
    case 'worktree:cleanup-failed':
      return { kind: 'worktree-failed', read: false, message: `${name} worktree clean up failed: ${event.error}`, ...cron };
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
            ? `${name} is queued at position ${event.position! + 1} of ${event.queueLength}, behind ${event.runningCount} running job${event.runningCount === 1 ? '' : 's'}`
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
    default:
      return null;
  }
}

class NotificationCenter {
  public items: NotificationRecord[];
  public ready: Promise<number> | null;
  public listening: boolean;

  public constructor() {
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
  public start(): Promise<number> {
    if (!this.listening) {
      bus.on('event', (event) => {
        try {
          this.record(event);
        } catch (err) {
          console.error(`[notifications] could not record ${event?.type}: ${(err as Error).message}`);
        }
      });
      this.listening = true;
    }
    this.ready = this.load();
    return this.ready;
  }

  public async load(): Promise<number> {
    const rows = await db().selectFrom('notifications').selectAll().orderBy('at', 'desc').execute();
    // Anything past the cap is deleted here rather than kept. A prune
    // interrupted by a restart, or one whose delete lost a race with its own
    // write, leaves rows behind; this is what stops them accumulating.
    for (const stale of rows.splice(MAX_NOTIFICATIONS)) {
      await db().deleteFrom('notifications').where('id', '=', stale.id).execute().catch(() => {});
    }
    this.items = [...this.items, ...rows.map(fromRow)];
    return this.items.length;
  }

  /** Turns one bus event into however many notifications it is worth. */
  public record(event: BusEvent): void {
    const described = describe(event as DescribableEvent);
    if (!described) return;
    for (const one of ([] as NotificationDraft[]).concat(described)) this.add(one);
  }

  /**
   * Adds one, announces it, and writes it down. The disk write is not waited
   * on: a notification that cannot be written is still worth showing, and the
   * event that produced it must not be held up by a filesystem.
   */
  public add({ kind, message, read = true, cronId = null, cronName = null, jobKind = 'cron' }: NotificationDraft): NotificationRecord {
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
    } as NotificationRecord;
    this.items.unshift(record);
    const pruned = this.items.length > MAX_NOTIFICATIONS ? this.items.splice(MAX_NOTIFICATIONS) : [];
    emit('notification:new', { notification: this.view(record), unread: this.unreadCount() });
    void this.persist(record);
    for (const old of pruned) void this.remove(old);
    return record;
  }

  /** Marks the given ids read, and answers with what is still unread. */
  public async markRead(ids: string | string[] | null | undefined): Promise<{ marked: number; unread: number }> {
    await this.ready;
    const wanted = new Set(([] as string[]).concat(ids ?? []));
    const changed: NotificationRecord[] = [];
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

  /** Marks every stored notification read, which is the drawer's one button. */
  public async markAllRead(): Promise<{ marked: number; unread: number }> {
    await this.ready;
    const changed = this.items.filter((record) => !record.read);
    for (const record of changed) record.read = true;
    await Promise.all(changed.map((record) => this.persist(record)));
    if (changed.length) emit('notification:read', { ids: changed.map((record) => record.id), unread: 0 });
    return { marked: changed.length, unread: 0 };
  }

  /**
   * One page, newest first. `before` is the id of the last one already shown,
   * which is a cursor rather than an offset on purpose: notifications arrive
   * while the list is open, and an offset would show one of them twice.
   *
   * `unreadOnly` pages the unread ones alone, for the drawer's filter. The
   * cursor is an id either way, so it keeps working across the filter being
   * turned on: the read ones between two unread ones are simply skipped.
   */
  public async page({
    before = null,
    limit = PAGE_SIZE,
    unreadOnly = false,
  }: { before?: string | null; limit?: unknown; unreadOnly?: boolean } = {}): Promise<NotificationPage> {
    await this.ready;
    const size = Math.max(1, Math.min(100, Number(limit) || PAGE_SIZE));
    let start = 0;
    if (before) {
      const index = this.items.findIndex((record) => record.id === before);
      // A cursor that is no longer here — pruned, or from an older run — starts
      // again from the top rather than answering with nothing.
      start = index >= 0 ? index + 1 : 0;
    }
    // The filter is applied after the cursor so the cursor stays an index into
    // the one list everything else — prune, mark read, the event stream — uses.
    const rest = unreadOnly ? this.items.slice(start).filter((record) => !record.read) : this.items.slice(start);
    const items = rest.slice(0, size);
    return {
      items: items.map((record) => this.view(record)),
      // The cursor for the next page, and null when this was the last of them.
      nextBefore: rest.length > size ? items.at(-1)?.id ?? null : null,
      unread: this.unreadCount(),
      total: unreadOnly ? this.unreadCount() : this.items.length,
    };
  }

  /** The in-flight write is ours, not the reader's. */
  public view(record: NotificationRecord): NotificationView {
    const { writing, ...rest } = record;
    return rest;
  }

  public unreadCount(): number {
    let count = 0;
    for (const record of this.items) if (!record.read) count += 1;
    return count;
  }

  /**
   * Writes one record, and remembers the write while it is in flight.
   *
   * A burst of notifications can prune a record before its own row has been
   * written, and a delete that lands first deletes nothing — the write then
   * inserts the row and it is there for good. `writing` is what `remove`
   * waits on so that cannot happen.
   */
  public async persist(record: NotificationRecord): Promise<void> {
    const write = this.write(record);
    record.writing = write;
    await write;
    if (record.writing === write) record.writing = null;
  }

  public async write(record: NotificationRecord): Promise<void> {
    try {
      const { id, ...columns } = toRow(record);
      await db()
        .insertInto('notifications')
        .values({ id, ...columns })
        .onConflict((conflict) => conflict.column('id').doUpdateSet(columns))
        .execute();
    } catch (err) {
      console.error(`[notifications] could not write ${record.id}: ${(err as Error).message}`);
    }
  }

  public async remove(record: NotificationRecord): Promise<void> {
    // Never delete ahead of the write that would put it back.
    await record.writing?.catch(() => {});
    await db().deleteFrom('notifications').where('id', '=', record.id).execute().catch(() => {});
  }
}

export const notificationCenter = new NotificationCenter();

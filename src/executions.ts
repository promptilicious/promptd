import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EXECUTIONS_DIR } from './paths.js';
import { normalizeUsageDelay } from './usage.js';
import type { Execution, ExecutionInput, ExecutionStatus } from './types.js';

export interface ExecutionPage {
  items: Execution[];
  nextBefore: string | null;
  total: number;
  scheduled: number;
}

/**
 * One-time executions: a prompt with a date instead of a cron expression.
 *
 * Everything a cron carries applies — working directory, model, effort, the
 * usage delay, the prompt prefix, the pause — and the only difference is when it
 * fires. They live in their own folder so the cron file watcher has nothing
 * extra to poll, and they write their logs into the same logs folder as crons,
 * each under its own id.
 */

/** One screenful for the home page's "load older" button. */
export const PAGE_SIZE = 10;

/**
 * Where an execution is in its one life.
 *
 * `scheduled` is the only state that arms a timer. `done` keeps the record as
 * history, still re-runnable by hand, and `cancelled` is a trigger the user
 * dropped while it waited on usage — neither re-fires on its own.
 */
export const STATUSES: ExecutionStatus[] = ['scheduled', 'running', 'done', 'cancelled'];

function executionFile(id: string): string {
  return path.join(EXECUTIONS_DIR, `${id}.json`);
}

/** A date the browser's datetime-local field produced, or null if it is not one. */
export function parseScheduledAt(input: unknown): Date | null {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Newest first: the furthest-out schedule at the top, then back through
 * history. A record with an unreadable date sorts last rather than first, so a
 * hand-edited file cannot push itself to the top of the list.
 */
export function byScheduledAtDesc(
  a: Pick<Execution, 'createdAt' | 'scheduledAt'>,
  b: Pick<Execution, 'createdAt' | 'scheduledAt'>,
): number {
  const left = Date.parse(a.scheduledAt ?? '') || 0;
  const right = Date.parse(b.scheduledAt ?? '') || 0;
  if (left !== right) return right - left;
  return String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''));
}

export async function listExecutions(): Promise<Execution[]> {
  let names: string[];
  try {
    names = await fs.readdir(EXECUTIONS_DIR);
  } catch {
    return [];
  }
  const executions: Execution[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(EXECUTIONS_DIR, name), 'utf8');
      const execution = JSON.parse(raw) as Execution;
      execution.id ||= name.replace(/\.json$/, '');
      executions.push(execution);
    } catch (err) {
      console.error(`[executions] skipping unreadable execution ${name}: ${(err as Error).message}`);
    }
  }
  return executions.sort(byScheduledAtDesc);
}

export async function getExecution(id: string): Promise<Execution | null> {
  try {
    return JSON.parse(await fs.readFile(executionFile(id), 'utf8')) as Execution;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Temp file then rename, so a crash never leaves half a JSON file behind. */
async function writeExecution(execution: Execution): Promise<void> {
  const target = executionFile(execution.id);
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.mkdir(EXECUTIONS_DIR, { recursive: true });
  await fs.writeFile(tmp, `${JSON.stringify(execution, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, target);
}

export async function createExecution(input: ExecutionInput): Promise<Execution> {
  const now = new Date().toISOString();
  const execution: Execution = {
    id: randomUUID(),
    name: input.name,
    description: input.description ?? '',
    scheduledAt: input.scheduledAt,
    workingDirectory: input.workingDirectory ?? '',
    useWorktree: Boolean(input.useWorktree),
    cleanupWorktree: true,
    model: input.model ?? '',
    effort: input.effort ?? '',
    usageDelay: normalizeUsageDelay(input.usageDelay),
    prompt: input.prompt ?? '',
    isActive: Boolean(input.isActive),
    nodeId: input.nodeId ?? '',
    status: 'scheduled',
    createdAt: now,
    updatedAt: now,
    firedAt: null,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunLog: null,
    stoppedBy: null,
  };
  await writeExecution(execution);
  return execution;
}

/**
 * A save that moves the date re-arms the execution, whatever it did last: the
 * user has given it a new time, and a record stuck at `done` would sit there
 * showing a schedule it would never keep. Everything else is an edit in place.
 *
 * This holds during a run too. The run finishing checks whether the record is
 * still `running` before it writes `done`, so a date set while claude was
 * working survives rather than being closed over.
 */
export async function updateExecution(id: string, input: ExecutionInput): Promise<Execution | null> {
  const existing = await getExecution(id);
  if (!existing) return null;
  const rescheduled = input.scheduledAt !== existing.scheduledAt;
  const execution: Execution = {
    ...existing,
    name: input.name,
    description: input.description ?? '',
    scheduledAt: input.scheduledAt,
    workingDirectory: input.workingDirectory ?? '',
    useWorktree: Boolean(input.useWorktree),
    cleanupWorktree: true,
    model: input.model ?? '',
    effort: input.effort ?? '',
    usageDelay: normalizeUsageDelay(input.usageDelay),
    prompt: input.prompt ?? '',
    isActive: Boolean(input.isActive),
    nodeId: input.nodeId ?? '',
    updatedAt: new Date().toISOString(),
    ...(rescheduled ? { status: 'scheduled', firedAt: null } : {}),
  };
  await writeExecution(execution);
  return execution;
}

/** Records the outcome of a run on the execution itself, like patchCron does. */
export async function patchExecution(id: string, patch: Partial<Execution>): Promise<Execution | null> {
  const existing = await getExecution(id);
  if (!existing) return null;
  const execution: Execution = { ...existing, ...patch };
  await writeExecution(execution);
  return execution;
}

export async function deleteExecution(id: string): Promise<boolean> {
  try {
    await fs.unlink(executionFile(id));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * One page, newest first. `before` is the id of the last one already shown
 * rather than an offset, for the same reason the notification drawer works that
 * way: records are created while the list is open, and an offset would show one
 * of them a second time.
 */
export async function pageExecutions({
  before = null,
  limit = PAGE_SIZE,
}: { before?: string | null; limit?: unknown } = {}): Promise<ExecutionPage> {
  const all = await listExecutions();
  // Generous ceiling: the home page re-reads everything it has already shown in
  // one request whenever a run event redraws it, so the cap has to clear a list
  // the user has paged a long way down.
  const size = Math.max(1, Math.min(500, Number(limit) || PAGE_SIZE));
  let start = 0;
  if (before) {
    const index = all.findIndex((execution) => execution.id === before);
    // A cursor that is no longer here — deleted, or from an older page load —
    // starts again from the top rather than answering with nothing.
    start = index >= 0 ? index + 1 : 0;
  }
  const items = all.slice(start, start + size);
  return {
    items,
    nextBefore: start + size < all.length ? (items.at(-1)?.id ?? null) : null,
    total: all.length,
    // What the tab's sub line counts.
    scheduled: all.filter((execution) => execution.isActive && execution.status === 'scheduled').length,
  };
}

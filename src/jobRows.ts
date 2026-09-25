import type { CronTable, ExecutionTable } from './db.js';
import type { Cron, Execution, ExecutionStatus, JobBase, RunStatus } from './types.js';
import { normalizeUsageDelay } from './usage.js';

type JobColumns = Omit<CronTable, 'cron'>;

function flag(value: boolean): number {
  return value ? 1 : 0;
}

function parseUsageDelay(text: string): JobBase['usageDelay'] {
  try {
    return normalizeUsageDelay(JSON.parse(text));
  } catch {
    return normalizeUsageDelay({});
  }
}

function toColumns(job: JobBase): JobColumns {
  return {
    id: job.id,
    name: job.name,
    description: job.description ?? '',
    workingDirectory: job.workingDirectory ?? '',
    useWorktree: flag(job.useWorktree),
    cleanupWorktree: flag(job.cleanupWorktree),
    model: job.model ?? '',
    effort: job.effort ?? '',
    usageDelay: JSON.stringify(normalizeUsageDelay(job.usageDelay)),
    prompt: job.prompt ?? '',
    isActive: flag(job.isActive),
    nodeId: job.nodeId ?? '',
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    lastRunAt: job.lastRunAt ?? null,
    lastRunStatus: job.lastRunStatus ?? null,
    lastRunLog: job.lastRunLog ?? null,
    lastRunDurationSeconds: job.lastRunDurationSeconds ?? null,
    lifetimeRuns: job.lifetimeRuns ?? null,
    lifetimeCostUsd: job.lifetimeCostUsd ?? null,
    lifetimeRuntimeSeconds: job.lifetimeRuntimeSeconds ?? null,
  };
}

// A counter never written is left off the record rather than read as zero:
// its absence is what tells the hub to backfill it from the logs.
function fromColumns(row: JobColumns): JobBase {
  const job: JobBase = {
    id: row.id,
    name: row.name,
    description: row.description,
    workingDirectory: row.workingDirectory,
    useWorktree: Boolean(row.useWorktree),
    cleanupWorktree: Boolean(row.cleanupWorktree),
    model: row.model,
    effort: row.effort,
    usageDelay: parseUsageDelay(row.usageDelay),
    prompt: row.prompt,
    isActive: Boolean(row.isActive),
    nodeId: row.nodeId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastRunAt: row.lastRunAt,
    lastRunStatus: row.lastRunStatus as RunStatus | null,
    lastRunLog: row.lastRunLog,
  };
  if (row.lastRunDurationSeconds !== null) job.lastRunDurationSeconds = Number(row.lastRunDurationSeconds);
  if (row.lifetimeRuns !== null) job.lifetimeRuns = Number(row.lifetimeRuns);
  if (row.lifetimeCostUsd !== null) job.lifetimeCostUsd = Number(row.lifetimeCostUsd);
  if (row.lifetimeRuntimeSeconds !== null) job.lifetimeRuntimeSeconds = Number(row.lifetimeRuntimeSeconds);
  return job;
}

export function cronToRow(cron: Cron): CronTable {
  return { ...toColumns(cron), cron: cron.cron };
}

export function rowToCron(row: CronTable): Cron {
  return { ...fromColumns(row), cron: row.cron };
}

export function executionToRow(execution: Execution): ExecutionTable {
  return {
    ...toColumns(execution),
    scheduledAt: execution.scheduledAt ?? null,
    status: execution.status,
    firedAt: execution.firedAt ?? null,
    stoppedBy: execution.stoppedBy ?? null,
  };
}

export function rowToExecution(row: ExecutionTable): Execution {
  return {
    ...fromColumns(row),
    scheduledAt: row.scheduledAt,
    status: row.status as ExecutionStatus,
    firedAt: row.firedAt,
    stoppedBy: row.stoppedBy,
  };
}

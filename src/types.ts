export type JobKind = 'cron' | 'execution';

export type UsageDelayCategoryId = 'credits' | 'fable' | 'session' | 'weekly';

export type UsageDelay = Record<UsageDelayCategoryId, boolean>;

export type UsageThresholds = Record<UsageDelayCategoryId, number>;

export type ExecutionStatus = 'cancelled' | 'done' | 'running' | 'scheduled';

export type RunStatus = 'failed' | 'interrupted' | 'stopped' | 'succeeded';

export type RunSource = 'manual' | 'missed' | 'schedule';

export interface LifetimeStats {
  lifetimeRuns?: number;
  lifetimeCostUsd?: number;
  lifetimeRuntimeSeconds?: number;
}

/** What every job carries, whichever kind it is. */
export interface JobBase extends LifetimeStats {
  id: string;
  name: string;
  description: string;
  workingDirectory: string;
  useWorktree: boolean;
  cleanupWorktree: boolean;
  model: string;
  effort: string;
  usageDelay: UsageDelay;
  prompt: string;
  isActive: boolean;
  nodeId?: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  lastRunStatus: RunStatus | null;
  lastRunLog: string | null;
  lastRunDurationSeconds?: number;
}

export interface Cron extends JobBase {
  cron: string;
}

export interface Execution extends JobBase {
  scheduledAt: string | null;
  status: ExecutionStatus;
  firedAt: string | null;
  stoppedBy: string | null;
}

export type Job = (Cron & { kind: 'cron' }) | (Execution & { kind: 'execution' });

/** The fields a form submits, before the store adds ids, dates and run bookkeeping. */
export type CronInput = Pick<
  Cron,
  | 'cleanupWorktree'
  | 'cron'
  | 'description'
  | 'effort'
  | 'isActive'
  | 'model'
  | 'name'
  | 'nodeId'
  | 'prompt'
  | 'usageDelay'
  | 'useWorktree'
  | 'workingDirectory'
>;

export type ExecutionInput = Omit<CronInput, 'cron'> & Pick<Execution, 'scheduledAt'>;

export interface UsageWindow {
  key: string;
  kind: string | null;
  scope: string | null;
  label: string;
  detail: string;
  note?: string;
  usedPercent: number;
  severity: 'critical' | 'normal' | 'warning';
  resetsAt: string | null;
}

export interface UsageReading {
  ok: boolean;
  reason: string | null;
  windows: UsageWindow[];
  checkedAt: string | null;
  stale: boolean;
}

export interface UsageBlocker {
  id: string;
  label: string;
  usedPercent?: number;
  threshold?: number;
  resetsAt?: string | null;
}

export interface RunWait {
  kind: 'queue' | 'usage';
  since: string;
  detail: string;
}

/** An in-flight run, JSON-safe for the API. */
export interface RunInfo {
  runId: string;
  cronId: string;
  cronName: string;
  kind: JobKind;
  logFile: string;
  startedAt: string;
  source: RunSource;
  pid: number | null;
  stopping: boolean;
  stoppedBy: string | null;
  heldSince: string | null;
  averageRuntimeMs: number | null;
}

/** A trigger that cannot run yet: held for usage, or queued behind the concurrent job limit. */
export interface DelayEntry {
  cronId: string;
  cronName: string;
  kind: JobKind;
  source: RunSource;
  hold: 'concurrency' | 'usage';
  arrivedAt: string;
  delayedAt: string;
  checkedAt: string;
  reasons: UsageBlocker[];
  resumeAt?: string | null;
  limit?: number;
  waits?: RunWait[];
  position?: number;
  queueLength?: number;
  runningCount?: number;
}

export interface PauseState {
  mode: 'manual' | 'update';
  label: string;
  option: string | null;
  startedAt: string;
  until: string | null;
}

export interface PauseInfo {
  paused: boolean;
  mode: PauseState['mode'] | null;
  option?: string | null;
  label: string | null;
  badge: string | null;
  until: string | null;
  startedAt: string | null;
  remainingMs: number | null;
  cancellable: boolean;
  runningCount: number;
  droppedCount: number;
}

export interface BusyJob {
  name: string;
  state: 'queued' | 'running' | 'scheduled';
  until?: string | null;
  startsAt?: string;
  averageRuntimeSeconds?: number | null;
}

export interface DelayOutlook {
  usage: UsageBlocker[];
  concurrency: { limit: number; busy: BusyJob[] } | null;
}

export interface ConcurrencyInfo {
  limit: number;
  defaultLimit: number;
  runningCount: number;
  queuedCount: number;
  usageDelayedCount: number;
  armedCrons: number;
  armedExecutions: number;
  nextSlotAt: string | null;
  running: Array<{
    cronId: string;
    cronName: string;
    kind: JobKind;
    startedAt: string;
    averageRuntimeSeconds: number | null;
    nodeId?: string;
    nodeName?: string;
  }>;
  queued: Array<DelayEntry & { nodeId?: string; nodeName?: string }>;
}

export interface Settings {
  serverName: string;
  serverColor: string;
  selfUpdate: boolean;
  updateCheckIntervalHours: number;
  lastUpdateCheckAt: string | null;
  lastUpdateLaunchedAt: string | null;
  lastUpdateFromCommit: string | null;
  maxConcurrentJobs: number;
  usageDelayThresholds: UsageThresholds;
  defaultWorkingDirectory: string;
  defaultPrompt: string;
  commonCommands: string;
  defaultWorktreeInclude: string;
  logsMigrated: boolean;
  defaultNodeId: string;
  localNodeAgentCheckedAt: string | null;
}

/** The part of the settings a node needs to run its jobs. */
export type NodeSettings = Pick<Settings, 'defaultWorktreeInclude' | 'maxConcurrentJobs' | 'usageDelayThresholds'>;

/** Everything on the event bus has a type and a time; the rest depends on the type. */
export interface BusEvent {
  type: string;
  at: string;
  [key: string]: unknown;
}

export interface ModelCatalogState {
  models: Array<{ value: string; label: string }>;
  discoveredAt: string | null;
  loading: boolean;
  error: string | null;
}

export interface SystemSample {
  at: string;
  cpu: number | null;
  memory: number | null;
  io: number | null;
  disk: number | null;
}

/** What a node's report says about one of its jobs. */
export interface JobView {
  nextRunAt: string | null;
  currentRun: RunInfo | null;
  delayed: DelayEntry | null;
  delayRisk: DelayOutlook | null;
}

export interface NodeCounts {
  scheduled: number;
  running: number;
  delayed: number;
  queued: number;
  usageDelayed: number;
  armedCrons: number;
  armedExecutions: number;
  concurrencyLimit: number;
}

export interface NodeStatus {
  pause: PauseInfo;
  concurrency: ConcurrencyInfo;
  counts: NodeCounts;
  jobs: Record<string, JobView>;
  activeLogs: Array<{ jobId: string; file: string }>;
  usage: UsageReading;
  models: ModelCatalogState;
  system: Record<string, unknown> & { latest?: SystemSample | null };
}

export interface NodeIdentity {
  id: string;
  name: string;
  instance: string;
  hostname: string;
  platform: string;
  commit: string | null;
  startedAt: string;
}

export interface JobPatch {
  kind: JobKind;
  id: string;
  patch: Partial<Cron> | Partial<Execution>;
}

export interface LogChunk {
  jobId: string;
  file: string;
  offset: number;
  data: string;
}

export type NodeCommandType = 'refreshModels' | 'run' | 'stop';

export interface NodeCommand {
  id: string;
  type: NodeCommandType;
  jobId: string | null;
  at: string;
}

export interface CommandResult {
  id: string;
  ok: boolean;
  error?: string;
  result?: Record<string, unknown> | null;
}

export interface NodeReport {
  node: NodeIdentity;
  logs: LogChunk[];
  patches: JobPatch[];
  events: BusEvent[];
  commandResults: CommandResult[];
  status: NodeStatus;
}

export interface NodeWork {
  node: { id: string; isDefault: boolean };
  crons: Cron[];
  executions: Execution[];
  settings: NodeSettings;
  pause: PauseState | null;
  commands: NodeCommand[];
}

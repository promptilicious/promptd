import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { bus, emit } from './events.js';
import { db } from './db.js';
import { NODE_TOKEN_FILE } from './paths.js';
import { listCrons, logPath, patchCron, pruneLogs } from './store.js';
import { STATUSES, getExecution, listExecutions, patchExecution } from './executions.js';
import { DEFAULT_MAX_CONCURRENT_JOBS, patchSettings } from './settings.js';
import { HISTORY_WINDOW_MS, SAMPLE_INTERVAL_MS, SYSTEM_METRICS } from './system.js';
import type {
  BusEvent,
  CommandResult,
  ConcurrencyInfo,
  Cron,
  Execution,
  JobPatch,
  JobView,
  LogChunk,
  ModelCatalogState,
  NodeCommand,
  NodeCommandType,
  NodeCounts,
  NodeSettings,
  NodeStatus,
  PauseInfo,
  PauseState,
  Settings,
  SystemSample,
  UsageReading,
} from './types.js';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTER_SCRIPT = path.join(PROJECT_DIR, 'scripts', 'register-app-mac-os.sh');
const OFFLINE_AFTER_MS = 15 * 1000;
const COMMAND_TTL_MS = 60 * 1000;
const JOBS_CACHE_MS = 10 * 1000;
const MODEL_REFRESH_WAIT_MS = 90 * 1000;

const BOOKKEEPING_FIELDS = new Set([
  'lastRunAt',
  'lastRunStatus',
  'lastRunLog',
  'lastRunDurationSeconds',
  'lifetimeRuns',
  'lifetimeCostUsd',
  'lifetimeRuntimeSeconds',
  'status',
  'firedAt',
  'stoppedBy',
]);

const NO_USAGE: UsageReading = { ok: false, reason: 'no node is online to read usage', windows: [], checkedAt: null, stale: false };

export interface HubNode {
  id: string;
  name: string;
  hostname: string | null;
  platform: string | null;
  commit: string | null;
  startedAt?: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  instance: string | null;
  status: NodeStatus | null;
  samples: SystemSample[];
  commands: NodeCommand[];
}

export type OnlineHubNode = HubNode & { status: NodeStatus };

export interface NodeListing {
  id: string;
  name: string;
  hostname: string | null;
  platform: string | null;
  commit: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  startedAt: string | null;
  online: boolean;
  isDefault: boolean;
  running: number;
  scheduled: number;
}

export interface NodeSummary {
  id: string | null;
  name: string | null;
  online: boolean;
}

export type ForgetResult = { ok: true } | { ok: false; status: number; error: string };

interface JobsCache {
  at: number;
  crons: Cron[];
  executions: Execution[];
}

type ReportedEvent = BusEvent & { sample?: SystemSample; cronId?: string };

export class HubError extends Error {
  public status: number;

  public constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function errorCode(err: unknown): unknown {
  return typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
}

function errorMessage(err: unknown): unknown {
  return typeof err === 'object' && err !== null && 'message' in err ? err.message : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function sum<T>(nodes: T[], read: (node: T) => unknown): number {
  return nodes.reduce((total, node) => total + (Number(read(node)) || 0), 0);
}

function sameSecret(given: unknown, expected: unknown): boolean {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

class Hub {
  private token: string | null;
  public nodes: Map<string, HubNode>;
  private settings: Partial<Settings>;
  private pauseState: PauseState | null;
  private pauseTimer: ReturnType<typeof setTimeout> | null;
  public jobsCache: JobsCache | null;
  private saveTimer: ReturnType<typeof setTimeout> | null;

  public constructor() {
    this.token = null;
    this.nodes = new Map();
    this.settings = {};
    this.pauseState = null;
    this.pauseTimer = null;
    this.jobsCache = null;
    this.saveTimer = null;
  }

  public async start(settings: Settings): Promise<void> {
    this.settings = settings;
    this.token = await this.ensureToken();
    await this.loadNodes();
    bus.on('event', (event: BusEvent) => {
      if (event.type === 'crons:changed') this.jobsCache = null;
    });
  }

  public setSettings(settings: Settings): void {
    this.settings = settings;
  }

  private async ensureToken(): Promise<string> {
    const fromEnv = process.env.PROMPTD_NODE_TOKEN?.trim();
    if (fromEnv) return fromEnv;
    try {
      const existing = (await fsp.readFile(NODE_TOKEN_FILE, 'utf8')).trim();
      if (existing) return existing;
    } catch (err) {
      if (errorCode(err) !== 'ENOENT') throw err;
    }
    const token = randomBytes(32).toString('hex');
    await fsp.writeFile(NODE_TOKEN_FILE, `${token}\n`, { mode: 0o600 });
    console.log(`[hub] wrote a new node token to ${NODE_TOKEN_FILE}`);
    return token;
  }

  private async loadNodes(): Promise<void> {
    for (const saved of await db().selectFrom('nodes').selectAll().execute()) {
      this.nodes.set(saved.id, { ...saved, instance: null, status: null, samples: [], commands: [] });
    }
  }

  private saveNodes(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const rows = [...this.nodes.values()].map(({ id, name, hostname, platform, commit, firstSeenAt, lastSeenAt }) => ({
        id,
        name,
        hostname,
        platform,
        commit,
        firstSeenAt,
        lastSeenAt,
      }));
      if (!rows.length) return;
      db()
        .insertInto('nodes')
        .values(rows)
        .onConflict((conflict) =>
          conflict.column('id').doUpdateSet((eb) => ({
            name: eb.ref('excluded.name'),
            hostname: eb.ref('excluded.hostname'),
            platform: eb.ref('excluded.platform'),
            commit: eb.ref('excluded.commit'),
            lastSeenAt: eb.ref('excluded.lastSeenAt'),
          })),
        )
        .execute()
        .catch((err: unknown) => console.error(`[hub] could not save the node list: ${errorMessage(err)}`));
    }, 1000);
    this.saveTimer.unref?.();
  }

  private isOnline(node: HubNode | undefined | null): node is OnlineHubNode {
    return Boolean(node?.status) && Date.now() - Date.parse(node!.lastSeenAt) < OFFLINE_AFTER_MS;
  }

  private onlineNodes(): OnlineHubNode[] {
    return [...this.nodes.values()].filter((node) => this.isOnline(node));
  }

  public defaultNodeId(): string {
    return this.settings.defaultNodeId || '';
  }

  private defaultNode(): OnlineHubNode | null {
    const node = this.nodes.get(this.defaultNodeId());
    return this.isOnline(node) ? node : null;
  }

  private nodeIdFor(job: Cron | Execution): string {
    return job.nodeId || this.defaultNodeId();
  }

  public jobView(job: Cron | Execution): JobView | null {
    const node = this.nodes.get(this.nodeIdFor(job));
    if (!this.isOnline(node)) return null;
    return node.status.jobs?.[job.id] ?? null;
  }

  public nodeSummary(job: Cron | Execution): NodeSummary {
    const id = this.nodeIdFor(job);
    const node = this.nodes.get(id);
    return { id: id || null, name: node?.name ?? id ?? null, online: this.isOnline(node) };
  }

  public listNodes(): NodeListing[] {
    return [...this.nodes.values()]
      .map((node): NodeListing => ({
        id: node.id,
        name: node.name,
        hostname: node.hostname,
        platform: node.platform,
        commit: node.commit,
        firstSeenAt: node.firstSeenAt,
        lastSeenAt: node.lastSeenAt,
        startedAt: node.startedAt ?? null,
        online: this.isOnline(node),
        isDefault: node.id === this.defaultNodeId(),
        running: this.isOnline(node) ? node.status.counts?.running ?? 0 : 0,
        scheduled: this.isOnline(node) ? node.status.counts?.scheduled ?? 0 : 0,
      }))
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
  }

  public forgetNode(id: string): ForgetResult {
    const node = this.nodes.get(id);
    if (!node) return { ok: false, status: 404, error: 'node not found' };
    if (this.isOnline(node)) return { ok: false, status: 409, error: 'this node is online; stop it before removing it' };
    this.nodes.delete(id);
    db()
      .deleteFrom('nodes')
      .where('id', '=', id)
      .execute()
      .catch((err: unknown) => console.error(`[hub] could not remove node "${id}": ${errorMessage(err)}`));
    return { ok: true };
  }

  public isRunningLog(jobId: string, file: string): boolean {
    return this.onlineNodes().some((node) => node.status.activeLogs?.some((log) => log.jobId === jobId && log.file === file));
  }

  public command(nodeId: string, type: NodeCommandType, jobId: string | null = null): NodeCommand | null {
    const node = this.nodes.get(nodeId);
    if (!this.isOnline(node)) return null;
    const command: NodeCommand = { id: randomUUID(), type, jobId, at: new Date().toISOString() };
    node.commands.push(command);
    return command;
  }

  public jobsChanged(): void {
    this.jobsCache = null;
    emit('crons:changed');
  }

  private async allJobs(): Promise<JobsCache> {
    if (this.jobsCache && Date.now() - this.jobsCache.at < JOBS_CACHE_MS) return this.jobsCache;
    const [crons, executions] = await Promise.all([listCrons(), listExecutions()]);
    this.jobsCache = { at: Date.now(), crons, executions };
    return this.jobsCache;
  }


  public router(): express.Router {
    const router = express.Router();
    router.use(express.json({ limit: '20mb' }));
    router.use((req, res, next) => {
      const header = String(req.get('authorization') ?? '');
      const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      if (!given || !sameSecret(given, this.token)) return res.status(401).json({ error: 'invalid node token' });
      next();
    });
    router.post('/report', (req, res, next) => {
      this.ingest(req.body ?? {})
        .then((answer) => res.json(answer))
        .catch((err: unknown) => (err instanceof HubError ? res.status(err.status).json({ error: err.message }) : next(err)));
    });
    router.post('/leave', (req, res) => {
      const node = this.nodes.get(String(req.get('x-promptd-node') ?? ''));
      if (node && node.instance === String(req.get('x-promptd-instance') ?? '')) {
        node.status = null;
        node.instance = null;
        console.log(`[hub] node "${node.id}" signed off`);
      }
      res.json({ ok: true });
    });
    router.get('/work', (req, res, next) => {
      this.work(String(req.get('x-promptd-node') ?? ''), String(req.get('x-promptd-instance') ?? ''))
        .then((work) => res.json(work))
        .catch((err: unknown) => (err instanceof HubError ? res.status(err.status).json({ error: err.message }) : next(err)));
    });
    return router;
  }

  private claim(input: unknown): HubNode {
    const identity = asRecord(input);
    const id = String(identity?.id ?? '').trim();
    const instance = String(identity?.instance ?? '').trim();
    if (!id || !instance) throw new HubError('node id and instance are required', 400);
    const now = new Date().toISOString();
    let node = this.nodes.get(id);
    if (node && this.isOnline(node) && node.instance && node.instance !== instance) {
      throw new HubError(`another process is already syncing as node "${id}"; give this one its own PROMPTD_NODE_ID`, 409);
    }
    if (!node) {
      node = { id, firstSeenAt: now, instance: null, status: null, samples: [], commands: [] } as unknown as HubNode;
      this.nodes.set(id, node);
      console.log(`[hub] new node "${identity!.name ?? id}" (${id})`);
    }
    if (node.instance !== instance) {
      if (node.instance) console.log(`[hub] node "${id}" restarted`);
      node.samples = [];
      // The previous process may have carried these out without living to report it.
      const bornAt = Date.parse((identity!.startedAt ?? '') as string) || Date.now();
      node.commands = node.commands.filter((command) => Date.parse(command.at) > bornAt);
    }
    Object.assign(node, {
      name: String(identity!.name ?? id),
      hostname: (identity!.hostname ?? null) as string | null,
      platform: (identity!.platform ?? null) as string | null,
      commit: (identity!.commit ?? null) as string | null,
      startedAt: (identity!.startedAt ?? null) as string | null,
      instance,
      lastSeenAt: now,
    });
    this.saveNodes();
    return node;
  }

  private async ingest(body: Record<string, unknown>): Promise<{ ok: true; logOffsets: Record<string, number> }> {
    const node = this.claim(body.node);
    if (!this.defaultNodeId()) {
      this.settings = await patchSettings({ defaultNodeId: node.id });
      console.log(`[hub] "${node.name}" is the default node`);
    }

    const logOffsets: Record<string, number> = {};
    for (const chunk of (Array.isArray(body.logs) ? body.logs : []) as LogChunk[]) {
      const key = `${chunk.jobId}/${chunk.file}`;
      logOffsets[key] = await this.writeLogChunk(chunk).catch((err: unknown) => {
        console.error(`[hub] could not store log ${key} from "${node.id}": ${errorMessage(err)}`);
        return chunk.offset;
      });
    }

    const previous = node.status;
    node.status = (body.status as NodeStatus | null | undefined) ?? node.status;
    await this.applyPatches(node, Array.isArray(body.patches) ? body.patches : [], previous);

    const answered = new Set(((Array.isArray(body.commandResults) ? body.commandResults : []) as CommandResult[]).map((result) => result.id));
    for (const result of (body.commandResults ?? []) as CommandResult[]) {
      if (!result.ok) console.error(`[hub] node "${node.id}" could not carry out a command: ${result.error}`);
    }
    const cutoff = Date.now() - COMMAND_TTL_MS;
    node.commands = node.commands.filter((command) => !answered.has(command.id) && Date.parse(command.at) > cutoff);

    let queueChanged = false;
    for (const event of (Array.isArray(body.events) ? body.events : []) as ReportedEvent[]) {
      if (event?.type === 'pause:changed') continue;
      if (event?.type === 'queue:changed') {
        queueChanged = true;
        continue;
      }
      if (event?.type === 'system:sample') {
        node.samples.push(event.sample as SystemSample);
        const oldest = Date.now() - HISTORY_WINDOW_MS;
        while (node.samples.length && Date.parse(node.samples[0]!.at) < oldest) node.samples.shift();
        if (node.id !== this.defaultNodeId()) continue;
      }
      if (event?.type === 'run:finished' && event.cronId) {
        pruneLogs(event.cronId).catch((err: unknown) => console.error(`[hub] log cleanup failed for ${event.cronId}: ${errorMessage(err)}`));
      }
      bus.emit('event', { ...event, nodeId: node.id, nodeName: node.name });
    }
    if (queueChanged) emit('queue:changed', { ...this.concurrencyInfo() });
    return { ok: true, logOffsets };
  }

  /**
   * Writes one chunk at the offset the node says it starts at, and answers what
   * the hub now holds. A retry of a chunk already written lands on the same
   * bytes; a chunk past the end is refused, and the answer rewinds the node.
   */
  public async writeLogChunk({ jobId, file, offset, data }: LogChunk): Promise<number> {
    const target = logPath(String(jobId), String(file));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const size = await fsp
      .stat(target)
      .then((stat) => stat.size)
      .catch(() => 0);
    const start = Number(offset);
    if (!Number.isInteger(start) || start < 0 || start > size) return size;
    const bytes = Buffer.from(String(data ?? ''), 'base64');
    const handle = await fsp.open(target, size === 0 ? 'w' : 'r+');
    try {
      await handle.write(bytes, 0, bytes.length, start);
      await handle.truncate(start + bytes.length);
    } finally {
      await handle.close();
    }
    return start + bytes.length;
  }

  /**
   * Only run bookkeeping, and only for jobs this node runs or was running: a node
   * holds a token, not the right to rewrite another machine's prompts.
   */
  private async applyPatches(node: HubNode, patches: JobPatch[], previousStatus: NodeStatus | null): Promise<void> {
    if (!patches.length) return;
    const { crons, executions } = await this.allJobs();
    const owned = new Set(
      [...crons, ...executions].filter((job) => this.nodeIdFor(job) === node.id).map((job) => job.id),
    );
    for (const status of [previousStatus, node.status]) {
      for (const id of Object.keys(status?.jobs ?? {})) owned.add(id);
    }
    let wrote = false;
    for (const entry of patches) {
      if (!owned.has(entry?.id)) continue;
      const fields: Partial<Cron & Execution> = Object.fromEntries(Object.entries(entry.patch ?? {}).filter(([key]) => BOOKKEEPING_FIELDS.has(key)));
      if ('status' in fields && !(STATUSES as readonly unknown[]).includes(fields.status)) delete fields.status;
      // The node's copy can be a sync behind: a date saved on the hub mid-run has
      // already put the record back to scheduled, and closing it would undo that.
      if (entry.kind === 'execution' && fields.status === 'done') {
        const current = await getExecution(entry.id).catch(() => null);
        if (current && current.status !== 'running') {
          delete fields.status;
          delete fields.stoppedBy;
        }
      }
      if (!Object.keys(fields).length) continue;
      const write = entry.kind === 'execution' ? patchExecution : patchCron;
      await write(entry.id, fields).catch((err: unknown) => console.error(`[hub] could not record ${entry.id} from "${node.id}": ${errorMessage(err)}`));
      wrote = true;
    }
    if (wrote) this.jobsCache = null;
  }

  private async work(nodeId: string, instance: string): Promise<{
    node: { id: string; isDefault: boolean };
    crons: Cron[];
    executions: Execution[];
    settings: Partial<NodeSettings>;
    pause: PauseState | null;
    commands: NodeCommand[];
  }> {
    const node = this.nodes.get(nodeId);
    if (!node || node.instance !== instance) {
      throw new HubError('report before asking for work', 409);
    }
    const { crons, executions } = await this.allJobs();
    const mine = (job: Cron | Execution): boolean => this.nodeIdFor(job) === node.id;
    const commands = node.commands.slice();
    return {
      node: { id: node.id, isDefault: node.id === this.defaultNodeId() },
      crons: crons.filter(mine),
      executions: executions.filter(mine),
      settings: {
        maxConcurrentJobs: this.settings.maxConcurrentJobs,
        usageDelayThresholds: this.settings.usageDelayThresholds,
        defaultWorktreeInclude: this.settings.defaultWorktreeInclude ?? '',
      },
      pause: this.pauseState,
      commands,
    };
  }


  public isPaused(): boolean {
    return this.pauseState !== null;
  }

  public isPausedForUpdate(): boolean {
    return this.pauseState?.mode === 'update';
  }

  public runningCount(): number {
    return sum(this.onlineNodes(), (node) => node.status.counts?.running);
  }

  /** True once every online node has fetched the pause and stopped starting runs. */
  public everyNodeHolding(): boolean {
    return this.onlineNodes().every((node) => node.status.pause?.paused);
  }

  public pauseInfo(): PauseInfo {
    const nodes = this.onlineNodes();
    const runningCount = this.runningCount();
    if (!this.pauseState) {
      return { paused: false, mode: null, label: null, badge: null, until: null, startedAt: null, remainingMs: null, cancellable: false, runningCount, droppedCount: 0 };
    }
    const { mode, label, option, startedAt, until } = this.pauseState;
    return {
      paused: true,
      mode,
      option,
      label,
      badge: `Paused ${label}`,
      startedAt,
      until,
      remainingMs: until ? Math.max(0, Date.parse(until) - Date.now()) : null,
      cancellable: mode === 'manual',
      runningCount,
      droppedCount: sum(nodes, (node) => (node.status.pause?.paused ? node.status.pause.droppedCount : 0)),
    };
  }

  public async pauseAll({
    mode = 'manual',
    label,
    option = null,
    ms = null,
  }: {
    mode?: PauseState['mode'];
    label: string;
    option?: string | null;
    ms?: number | null;
  }): Promise<PauseInfo> {
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
    const startedAt = new Date();
    this.pauseState = {
      mode,
      label,
      option,
      startedAt: startedAt.toISOString(),
      until: ms ? new Date(startedAt.getTime() + ms).toISOString() : null,
    };
    if (ms) {
      this.pauseTimer = setTimeout(() => {
        this.resumeAll('timer expired').catch((err: unknown) => console.error(`[hub] resume failed: ${errorMessage(err)}`));
      }, ms);
      this.pauseTimer.unref?.();
    }
    console.log(`[hub] paused ${label} (${mode})`);
    emit('pause:changed', { ...this.pauseInfo() });
    return this.pauseInfo();
  }

  public async resumeAll(reason = 'cancelled'): Promise<PauseInfo> {
    if (!this.pauseState) return this.pauseInfo();
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
    const previous = this.pauseState;
    this.pauseState = null;
    console.log(`[hub] resumed after "${previous.label}" pause (${reason})`);
    emit('pause:changed', { ...this.pauseInfo(), resumedFrom: previous.label, reason });
    return this.pauseInfo();
  }


  /** Each node enforces its own limit, so the fleet's is their total, or none when any node has none. */
  private concurrencyLimit(nodes: OnlineHubNode[] = this.onlineNodes()): number {
    if (!nodes.length) return this.settings.maxConcurrentJobs ?? DEFAULT_MAX_CONCURRENT_JOBS;
    const limits = nodes.map((node) => Number(node.status.counts?.concurrencyLimit) || 0);
    return limits.includes(0) ? 0 : limits.reduce((a, b) => a + b, 0);
  }

  public health(): {
    scheduled: number;
    running: number;
    paused: boolean;
    delayed: number;
    queued: number;
    usageDelayed: number;
    concurrencyLimit: number;
    armedCrons: number;
    armedExecutions: number;
    usage: UsageReading;
    nodes: { total: number; online: number };
  } {
    const nodes = this.onlineNodes();
    const count = (key: keyof NodeCounts): number => sum(nodes, (node) => node.status.counts?.[key]);
    return {
      scheduled: count('scheduled'),
      running: count('running'),
      paused: this.isPaused(),
      delayed: count('delayed'),
      queued: count('queued'),
      usageDelayed: count('usageDelayed'),
      concurrencyLimit: this.concurrencyLimit(nodes),
      armedCrons: count('armedCrons'),
      armedExecutions: count('armedExecutions'),
      usage: this.defaultNode()?.status.usage ?? NO_USAGE,
      nodes: { total: this.nodes.size, online: nodes.length },
    };
  }

  public concurrencyInfo(): ConcurrencyInfo {
    const nodes = this.onlineNodes();
    const infos = nodes.map((node): { node: OnlineHubNode; info: Partial<ConcurrencyInfo> } => ({ node, info: node.status.concurrency ?? {} }));
    const tag =
      (node: OnlineHubNode) =>
      <T extends object>(row: T): T & { nodeId: string; nodeName: string } => ({ ...row, nodeId: node.id, nodeName: node.name });
    const slots = infos.map(({ info }) => info.nextSlotAt).filter(Boolean).sort();
    return {
      limit: this.concurrencyLimit(nodes),
      defaultLimit: DEFAULT_MAX_CONCURRENT_JOBS,
      runningCount: sum(infos, ({ info }) => info.runningCount),
      queuedCount: sum(infos, ({ info }) => info.queuedCount),
      usageDelayedCount: sum(infos, ({ info }) => info.usageDelayedCount),
      armedCrons: sum(infos, ({ info }) => info.armedCrons),
      armedExecutions: sum(infos, ({ info }) => info.armedExecutions),
      nextSlotAt: slots[0] ?? null,
      running: infos.flatMap(({ node, info }) => (info.running ?? []).map(tag(node))),
      queued: infos.flatMap(({ node, info }) => (info.queued ?? []).map(tag(node))),
    };
  }

  public systemState(): Record<string, unknown> {
    const node = this.defaultNode();
    if (!node?.status.system) {
      return {
        enabled: false,
        intervalMs: SAMPLE_INTERVAL_MS,
        windowMs: HISTORY_WINDOW_MS,
        metrics: SYSTEM_METRICS,
        host: null,
        detail: {},
        notes: {},
        latest: null,
        samples: [],
      };
    }
    return { ...node.status.system, latest: node.samples.at(-1) ?? node.status.system.latest ?? null, samples: node.samples };
  }

  public models(): ModelCatalogState {
    return this.defaultNode()?.status.models ?? { models: [], discoveredAt: null, loading: false, error: 'no node is online to ask' };
  }

  public async refreshModels(): Promise<ModelCatalogState> {
    const before = this.models().discoveredAt;
    for (const node of this.onlineNodes()) this.command(node.id, 'refreshModels');
    const deadline = Date.now() + MODEL_REFRESH_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const state = this.models();
      if (!state.loading && state.discoveredAt !== before) return state;
      if (!this.defaultNode()) break;
    }
    return this.models();
  }


  /**
   * An install registered before nodes existed has a launchd agent for the hub
   * and none for the node, so after the update that brings this code nothing
   * would run its jobs.
   */
  public async ensureLocalNodeAgent(): Promise<void> {
    if (process.platform !== 'darwin' || this.settings.localNodeAgentCheckedAt) return;
    const label = process.env.PROMPTD_LAUNCHD_LABEL ?? 'local.promptd';
    const hubPlist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    if (process.ppid !== 1 || !fs.existsSync(hubPlist)) return;
    const nodeLabel = process.env.PROMPTD_NODE_LAUNCHD_LABEL ?? `${label}.node`;
    const registered = await new Promise<boolean>((resolve) => {
      execFile('launchctl', ['print', `gui/${process.getuid!()}/${nodeLabel}`], (err) => resolve(!err));
    });
    if (!registered) {
      console.log(`[hub] no launchd agent for the local node; registering ${nodeLabel}`);
      const child = spawn('/bin/bash', [REGISTER_SCRIPT], {
        cwd: PROJECT_DIR,
        stdio: 'inherit',
        env: { ...process.env, NODE_ONLY: '1', LABEL: label, NODE_LABEL: nodeLabel },
      });
      const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
      if (code !== 0) {
        console.error(`[hub] registering the local node agent failed (exit ${code}); run ${REGISTER_SCRIPT} by hand`);
        return;
      }
    }
    this.settings = await patchSettings({ localNodeAgentCheckedAt: new Date().toISOString() });
  }
}

export const hub = new Hub();

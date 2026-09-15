import fsp from 'node:fs/promises';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { emit } from './events.js';
import { ROOT } from './paths.js';

/**
 * Machine stats for the header: how busy this computer is while it runs your
 * crons. Four readings, taken on one timer, kept for the last fifteen minutes.
 *
 * Nothing here is installed or bundled. Every figure comes from what the
 * platform already exposes — Node's own counters, `vm_stat`, `iostat`,
 * `/proc` — so the service is the same weight on a laptop as it is on a server.
 */

/** `0` turns the service off entirely; anything else is floored at a second. */
const CONFIGURED_INTERVAL = Number(process.env.SYSTEM_SAMPLE_MS ?? 5000);
export const SAMPLE_INTERVAL_MS = Number.isFinite(CONFIGURED_INTERVAL) && CONFIGURED_INTERVAL > 0
  ? Math.max(1000, CONFIGURED_INTERVAL)
  : 0;

/** The window the header chart draws. 15 minutes at 5s is 180 points. */
export const HISTORY_WINDOW_MS = 15 * 60 * 1000;

/**
 * What each meter is, handed to the page rather than duplicated there, so a
 * threshold moves in one place.
 *
 * `kind` is how the bar is filled: a percent metric fills against 100, a rate
 * has no ceiling and fills against the busiest moment in the window instead,
 * never less than `minScale` so an idle disk does not draw a full bar off a
 * 0.2 MB/s blip.
 */
export const SYSTEM_METRICS = [
  {
    id: 'cpu',
    label: 'CPU',
    title: 'CPU',
    unit: '%',
    kind: 'percent',
    warning: 75,
    critical: 90,
    detail: 'Share of all cores in use, averaged over the sample.',
  },
  {
    id: 'memory',
    label: 'Mem',
    title: 'Memory',
    unit: '%',
    kind: 'percent',
    warning: 75,
    critical: 90,
    detail: 'Memory in use: what is active, wired, or compressed.',
  },
  {
    id: 'io',
    label: 'I/O',
    title: 'Storage I/O',
    unit: 'MB/s',
    kind: 'rate',
    minScale: 50,
    detail: 'Bytes read and written per second, across every physical disk.',
  },
  {
    id: 'disk',
    label: 'Disk',
    title: 'Storage used',
    unit: '%',
    kind: 'percent',
    warning: 85,
    critical: 95,
    detail: 'How full the volume holding the storage root is.',
  },
];

/**
 * When a reading is worth telling someone about.
 *
 * Three rules keep these from becoming noise, and all three matter:
 *
 * 1. **A window, not a sample.** Every alert is judged on the mean of a whole
 *    minute. One busy five-second sample is a cron doing its job.
 * 2. **One alert per episode.** It fires when the metric crosses the line, and
 *    then says nothing until the metric has come back below the clear level.
 *    A disk sitting at 81% is one alert, not one every ten minutes forever.
 * 3. **Never more than one per metric per ten minutes**, whatever else happens.
 *
 * The clear level sits below the threshold on purpose: a metric hovering at the
 * line would otherwise alternate between firing and clearing.
 */
export const ALERT_COOLDOWN_MS = 10 * 60 * 1000;

/** The mean of one metric over the last `ms`, or null without a full window. */
function meanOver(samples, id, ms, intervalMs) {
  const needed = Math.max(1, Math.round(ms / intervalMs));
  const recent = samples.slice(-needed);
  if (recent.length < needed) return null;
  const values = recent.map((sample) => sample[id]).filter((value) => Number.isFinite(value));
  // A gap in the window is not a low reading; it is no reading, and no verdict.
  return values.length === needed ? values.reduce((sum, value) => sum + value, 0) / needed : null;
}

/** The middle value, which a burst cannot drag the way it drags a mean. */
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export const SYSTEM_ALERTS = [
  {
    id: 'cpu',
    label: 'High CPU',
    windowMs: 60 * 1000,
    threshold: 80,
    clear: 70,
    read(samples, intervalMs) {
      const value = meanOver(samples, 'cpu', this.windowMs, intervalMs);
      if (value === null) return null;
      return {
        value,
        breached: value >= this.threshold,
        cleared: value < this.clear,
        summary: `${Math.round(value)}% of all cores, averaged over the last minute`,
      };
    },
  },
  {
    id: 'memory',
    label: 'High memory',
    windowMs: 60 * 1000,
    threshold: 80,
    clear: 72,
    read(samples, intervalMs) {
      const value = meanOver(samples, 'memory', this.windowMs, intervalMs);
      if (value === null) return null;
      return {
        value,
        breached: value >= this.threshold,
        cleared: value < this.clear,
        summary: `${Math.round(value)}% of memory in use, averaged over the last minute`,
      };
    },
  },
  {
    /**
     * Throughput has no natural ceiling, so "high" here means high *for this
     * machine*: several times what this disk has been doing, and enough in
     * absolute terms to be worth saying.
     *
     * The baseline is the median of everything in the window older than the
     * last minute. A mean would be dragged upward by the very burst being
     * looked for, and would talk itself out of alerting. The absolute floor is
     * what stops an idle disk alerting because 0.05 MB/s became 0.4 MB/s.
     */
    id: 'io',
    label: 'Unusual storage I/O',
    windowMs: 60 * 1000,
    /** Multiples of the usual rate. */
    multiple: 4,
    /** Below this it is not worth calling unusual, whatever the multiple says. */
    floorMbPerSecond: 50,
    /** Five minutes of history before there is any "usual" to compare against. */
    baselineSamples: 60,
    read(samples, intervalMs) {
      const value = meanOver(samples, 'io', this.windowMs, intervalMs);
      if (value === null) return null;
      const windowCount = Math.max(1, Math.round(this.windowMs / intervalMs));
      const older = samples.slice(0, -windowCount).map((sample) => sample.io).filter((rate) => Number.isFinite(rate));
      if (older.length < this.baselineSamples) return null;
      const usual = median(older);
      const bar = Math.max(this.floorMbPerSecond, usual * this.multiple);
      return {
        value,
        breached: value >= bar,
        cleared: value < bar * 0.6,
        summary: `${round1(value)} MB/s over the last minute, against a usual ${round1(usual)} MB/s`,
      };
    },
  },
  {
    /**
     * Space does not move in minutes, so this one is judged on the latest
     * reading rather than an average. Rule 2 is what keeps a full disk from
     * saying so every ten minutes: it is one alert until space is freed.
     */
    id: 'disk',
    label: 'Low disk space',
    threshold: 80,
    clear: 75,
    read(samples) {
      const value = samples.at(-1)?.disk;
      if (!Number.isFinite(value)) return null;
      return {
        value,
        breached: value >= this.threshold,
        cleared: value < this.clear,
        summary: `${round1(100 - value)}% of the volume is free`,
      };
    },
  },
];

const round1 = (value) => Math.round(value * 10) / 10;
const round2 = (value) => Math.round(value * 100) / 100;

/** execFile as a promise that answers `null` instead of throwing. */
function run(command, args = [], timeout = 5000) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, maxBuffer: 1 << 20 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

// ---- CPU ---------------------------------------------------------------

/**
 * Busy and total jiffies across every core, cumulative since boot.
 *
 * `os.cpus()` is the only reading here that needs no process and no file, and it
 * is cumulative, so a percentage only exists as the difference between two of
 * these — which is why the first sample after startup reports no CPU figure.
 */
function cpuTotals() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const [kind, ms] of Object.entries(cpu.times)) {
      total += ms;
      if (kind === 'idle') idle += ms;
    }
  }
  return total > 0 ? { idle, total } : null;
}

// ---- memory ------------------------------------------------------------

/**
 * Memory in use on macOS.
 *
 * `os.freemem()` is not the number to draw here: macOS keeps file caches and
 * purgeable pages in what it calls used memory, so freemem reports a machine at
 * 95% that Activity Monitor calls 60%. This counts what Activity Monitor counts
 * — active, wired and compressed pages — which is the figure a person recognises.
 */
async function macMemory() {
  const out = await run('vm_stat');
  if (!out) return null;
  const pageSize = Number(/page size of (\d+) bytes/.exec(out)?.[1]) || 4096;
  const pages = (label) => {
    const match = new RegExp(`^${label}:\\s+(\\d+)\\.`, 'm').exec(out);
    return match ? Number(match[1]) : null;
  };
  const active = pages('Pages active');
  const wired = pages('Pages wired down');
  if (active === null || wired === null) return null;
  const compressed = pages('Pages occupied by compressor') ?? 0;
  return { usedBytes: (active + wired + compressed) * pageSize, totalBytes: os.totalmem() };
}

/** Memory in use on Linux, from MemAvailable — the kernel's own answer. */
async function linuxMemory() {
  const text = await fsp.readFile('/proc/meminfo', 'utf8').catch(() => null);
  if (!text) return null;
  const bytes = (label) => {
    const match = new RegExp(`^${label}:\\s+(\\d+) kB`, 'm').exec(text);
    return match ? Number(match[1]) * 1024 : null;
  };
  const total = bytes('MemTotal');
  const available = bytes('MemAvailable');
  if (!total || available === null) return null;
  return { usedBytes: total - available, totalBytes: total };
}

async function readMemory() {
  const platform = process.platform === 'darwin' ? await macMemory() : process.platform === 'linux' ? await linuxMemory() : null;
  if (platform) return platform;
  // Every platform can answer this much, even if it answers it coarsely.
  return { usedBytes: os.totalmem() - os.freemem(), totalBytes: os.totalmem() };
}

// ---- storage usage -----------------------------------------------------

/**
 * How full the volume holding the storage root is.
 *
 * The storage root rather than `/` on purpose: that is where logs accumulate,
 * so it is the volume whose filling up would actually break something here.
 * Used counts the whole filesystem, not just this user's share of it, which is
 * what "how full is the disk" means.
 */
async function readDiskUsage(target = ROOT) {
  if (typeof fsp.statfs === 'function') {
    const stats = await fsp.statfs(target).catch(() => null);
    if (stats?.blocks > 0) {
      return {
        usedBytes: (stats.blocks - stats.bfree) * stats.bsize,
        freeBytes: stats.bavail * stats.bsize,
        totalBytes: stats.blocks * stats.bsize,
      };
    }
  }
  // fs.statfs landed in Node 18.15; df is the answer on anything older.
  const out = await run('df', ['-kP', target]);
  const fields = out?.trim().split('\n').at(-1)?.trim().split(/\s+/);
  if (!fields || fields.length < 4) return null;
  const [total, used, available] = [Number(fields[1]), Number(fields[2]), Number(fields[3])];
  if (!Number.isFinite(total) || total <= 0) return null;
  return { usedBytes: used * 1024, freeBytes: available * 1024, totalBytes: total * 1024 };
}

// ---- storage I/O -------------------------------------------------------

/**
 * Throughput on macOS, from one long-lived `iostat` rather than one per sample.
 *
 * `iostat -w N` prints a line every N seconds covering exactly that interval,
 * which is the window we want anyway. The alternative — spawning `iostat -c 2
 * -w 1` on every tick — would blow a second of wall clock and a process every
 * five seconds, forever, to measure a fifth of the window it reports on.
 *
 * The line it prints is latched here and read by the sampler. If the process
 * dies the latch goes stale, the meter reports nothing rather than a frozen
 * number, and a respawn is tried on a backoff. A server killed outright leaves
 * this running for at most one interval: `iostat` exits on its own as soon as
 * the write of its next line finds the pipe closed.
 */
class IostatReader {
  constructor(intervalMs) {
    this.seconds = Math.max(1, Math.round(intervalMs / 1000));
    this.child = null;
    this.buffer = '';
    this.latest = null;
    this.reason = null;
    this.stopped = false;
    this.restartMs = 10000;
    this.restartTimer = null;
    /** The first row `iostat` prints averages since boot, so it is discarded. */
    this.sawFirstRow = false;
  }

  start() {
    this.stopped = false;
    this.spawn();
  }

  spawn() {
    if (this.stopped || this.child) return;
    this.sawFirstRow = false;
    this.buffer = '';
    let child;
    try {
      child = spawn('iostat', ['-d', '-w', String(this.seconds)], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (err) {
      this.reason = `iostat could not be started: ${err.message}`;
      return;
    }
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.consume(chunk));
    child.on('error', (err) => {
      this.reason = err.code === 'ENOENT' ? 'iostat is not installed' : `iostat failed: ${err.message}`;
      this.child = null;
      // A missing binary will still be missing in ten seconds; everything else
      // is worth another try.
      if (err.code !== 'ENOENT') this.scheduleRestart();
    });
    child.on('exit', () => {
      this.child = null;
      this.latest = null;
      if (!this.reason) this.reason = 'iostat stopped; restarting';
      this.scheduleRestart();
    });
  }

  scheduleRestart() {
    if (this.stopped || this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.restartMs = Math.min(this.restartMs * 2, 5 * 60 * 1000);
      this.spawn();
    }, this.restartMs);
    this.restartTimer.unref?.();
  }

  /**
   * One line per interval, after two header lines that `iostat` reprints as it
   * goes. A data row is every token being a number, three per disk — KB/t, tps,
   * MB/s — so the disks are summed by stepping over the row in threes.
   */
  consume(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const fields = line.trim().split(/\s+/).filter(Boolean);
      if (!fields.length || fields.length % 3 !== 0) continue;
      const numbers = fields.map(Number);
      if (numbers.some((value) => !Number.isFinite(value))) continue;
      if (!this.sawFirstRow) {
        this.sawFirstRow = true;
        continue;
      }
      let mbPerSecond = 0;
      let transfers = 0;
      for (let index = 0; index + 2 < numbers.length; index += 3) {
        transfers += numbers[index + 1];
        mbPerSecond += numbers[index + 2];
      }
      this.latest = { mbPerSecond, transfers, at: Date.now() };
      this.reason = null;
      this.restartMs = 10000;
    }
  }

  /** The last line, unless it is old enough that the process has clearly stalled. */
  read() {
    if (!this.latest) return null;
    if (Date.now() - this.latest.at > this.seconds * 3000) return null;
    return { mbPerSecond: this.latest.mbPerSecond, transfers: this.latest.transfers };
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.child?.kill();
    this.child = null;
  }
}

/** Partitions and loop devices would double-count, so only whole disks count. */
const PHYSICAL_DISK = /^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|xvd[a-z]+|mmcblk\d+|hd[a-z]+)$/;

/** Cumulative bytes and transfers across every physical disk, on Linux. */
async function linuxDiskCounters() {
  const text = await fsp.readFile('/proc/diskstats', 'utf8').catch(() => null);
  if (!text) return null;
  let sectors = 0;
  let transfers = 0;
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10 || !PHYSICAL_DISK.test(fields[2])) continue;
    sectors += Number(fields[5]) + Number(fields[9]);
    transfers += Number(fields[3]) + Number(fields[7]);
  }
  // A sector is 512 bytes in /proc/diskstats whatever the hardware uses.
  return { bytes: sectors * 512, transfers, at: Date.now() };
}

// ---- the service -------------------------------------------------------

class SystemMonitor {
  constructor() {
    /** The retained window, oldest first. @type {Array<object>} */
    this.samples = [];
    /** Byte counts and the like behind the latest percentages. */
    this.detail = {};
    /** Why a metric is reporting nothing, by metric id. */
    this.notes = {};
    this.timer = null;
    /** One tick at a time: a slow reading must not overlap the next. */
    this.sampling = false;
    this.cpuBaseline = null;
    this.ioBaseline = null;
    this.iostat = null;
    /** Per alert: whether it is currently firing, and when it last said so. */
    this.alerts = new Map();
    /** What is running right now, supplied by whoever owns the crons. */
    this.runningCrons = () => [];
  }

  get enabled() {
    return SAMPLE_INTERVAL_MS > 0;
  }

  /**
   * Starts sampling. The CPU and Linux I/O readings are differences between two
   * cumulative counters, so the first sample only takes the baseline: it carries
   * memory and storage, and reports nothing for those two until the next tick.
   * Reporting the since-boot average there instead would be a different number
   * wearing the same label.
   */
  start({ runningCrons } = {}) {
    if (typeof runningCrons === 'function') this.runningCrons = runningCrons;
    if (!this.enabled || this.timer) return;
    if (process.platform === 'darwin') {
      this.iostat = new IostatReader(SAMPLE_INTERVAL_MS);
      this.iostat.start();
    }
    this.timer = setInterval(() => {
      this.sample().catch((err) => console.error('[system]', err));
    }, SAMPLE_INTERVAL_MS);
    this.timer.unref?.();
    this.sample().catch((err) => console.error('[system]', err));
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.iostat?.stop();
    this.iostat = null;
  }

  /** Busy share of all cores since the previous tick, or null on the first one. */
  readCpu() {
    const now = cpuTotals();
    if (!now) return null;
    const before = this.cpuBaseline;
    this.cpuBaseline = now;
    if (!before) return null;
    const span = now.total - before.total;
    if (span <= 0) return null;
    const busy = span - (now.idle - before.idle);
    return round1(Math.max(0, Math.min(100, (busy / span) * 100)));
  }

  /** Throughput since the previous tick: latched on macOS, differenced on Linux. */
  async readIo() {
    if (process.platform === 'darwin') {
      const latest = this.iostat?.read();
      if (!latest) return { value: null, detail: null, note: this.iostat?.reason ?? 'waiting for the first iostat interval' };
      return { value: round2(latest.mbPerSecond), detail: { transfersPerSecond: Math.round(latest.transfers) }, note: null };
    }
    if (process.platform === 'linux') {
      const now = await linuxDiskCounters();
      if (!now) return { value: null, detail: null, note: '/proc/diskstats could not be read' };
      const before = this.ioBaseline;
      this.ioBaseline = now;
      if (!before) return { value: null, detail: null, note: null };
      const seconds = (now.at - before.at) / 1000;
      if (seconds <= 0) return { value: null, detail: null, note: null };
      const mbPerSecond = (now.bytes - before.bytes) / 1e6 / seconds;
      return {
        value: round2(Math.max(0, mbPerSecond)),
        detail: { transfersPerSecond: Math.round(Math.max(0, (now.transfers - before.transfers) / seconds)) },
        note: null,
      };
    }
    return { value: null, detail: null, note: `storage I/O is not read on ${process.platform}` };
  }

  /**
   * One reading of all four, taken together so the sample is one moment rather
   * than four. Every reader answers null instead of throwing, so a metric the
   * platform will not report costs an empty bar, not a dead service.
   */
  async sample() {
    if (this.sampling) return null;
    this.sampling = true;
    try {
      const cpu = this.readCpu();
      const [memory, io, disk] = await Promise.all([
        readMemory().catch(() => null),
        this.readIo().catch((err) => ({ value: null, detail: null, note: err.message })),
        readDiskUsage().catch(() => null),
      ]);

      const percentOf = (part, whole) => (whole > 0 ? round1(Math.max(0, Math.min(100, (part / whole) * 100))) : null);

      const sample = {
        at: new Date().toISOString(),
        cpu,
        memory: memory ? percentOf(memory.usedBytes, memory.totalBytes) : null,
        io: io.value,
        disk: disk ? percentOf(disk.usedBytes, disk.totalBytes) : null,
      };

      this.detail = {
        cpu: { cores: os.cpus().length, loadAverage: round2(os.loadavg()[0]) },
        memory: memory ? { ...memory } : null,
        io: io.detail,
        disk: disk ? { ...disk, path: ROOT } : null,
      };
      this.notes = {
        cpu: cpu === null ? (this.samples.length ? 'CPU could not be read' : 'waiting for a second reading') : null,
        memory: memory ? null : 'memory could not be read',
        io: io.note,
        disk: disk ? null : 'storage usage could not be read',
      };

      this.samples.push(sample);
      this.trim();
      this.checkAlerts();
      // Pushed rather than polled: the page holds its own copy of the window and
      // appends, so a 5-second meter costs one event, not a request per tab. The
      // detail rides along because the tooltips draw it, and a reading with no
      // detail behind it would have to be fetched separately anyway.
      emit('system:sample', { sample, detail: this.detail, notes: this.notes });
      return sample;
    } finally {
      this.sampling = false;
    }
  }

  /**
   * Every alert, against the window just added to.
   *
   * The three rules above SYSTEM_ALERTS are all applied here: a firing alert
   * says nothing until it has cleared, a cleared one can fire again, and
   * neither can happen more than once per ten minutes.
   */
  checkAlerts() {
    const now = Date.now();
    for (const alert of SYSTEM_ALERTS) {
      const state = this.alerts.get(alert.id) ?? { firing: false, lastSentAt: 0 };
      this.alerts.set(alert.id, state);
      const reading = alert.read(this.samples, SAMPLE_INTERVAL_MS);
      if (!reading) continue;

      if (state.firing) {
        // Still over the line is the same episode, not a new one.
        if (reading.cleared) state.firing = false;
        continue;
      }
      if (!reading.breached) continue;

      // Marked as firing even when the cooldown swallows the notification, so
      // a cooldown expiring mid-episode does not produce a late one.
      state.firing = true;
      if (now - state.lastSentAt < ALERT_COOLDOWN_MS) continue;
      state.lastSentAt = now;
      const running = this.runningCrons();
      console.warn(`[system] ${alert.label}: ${reading.summary}`);
      emit('system:alert', {
        metric: alert.id,
        label: alert.label,
        summary: reading.summary,
        value: round1(reading.value),
        threshold: alert.threshold ?? null,
        running,
      });
    }
  }

  /** Drops anything older than the window, by time rather than by count. */
  trim() {
    const cutoff = Date.now() - HISTORY_WINDOW_MS;
    while (this.samples.length && Date.parse(this.samples[0].at) < cutoff) this.samples.shift();
  }

  /** Everything the page needs to draw the meters and their charts from cold. */
  state() {
    this.trim();
    return {
      enabled: this.enabled,
      intervalMs: SAMPLE_INTERVAL_MS,
      windowMs: HISTORY_WINDOW_MS,
      metrics: SYSTEM_METRICS,
      host: {
        platform: process.platform,
        hostname: os.hostname(),
        cores: os.cpus().length,
        cpuModel: os.cpus()[0]?.model ?? null,
        totalMemoryBytes: os.totalmem(),
        storagePath: ROOT,
      },
      detail: this.detail,
      notes: this.notes,
      latest: this.samples.at(-1) ?? null,
      samples: this.samples,
    };
  }
}

export const systemMonitor = new SystemMonitor();

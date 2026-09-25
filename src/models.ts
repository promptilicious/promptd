import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { emit } from './events.js';
import type { ModelCatalogState } from './types.js';

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

// Documented shorthands that always point at the newest model in a family.
const ALIASES = ['opus', 'sonnet', 'haiku', 'fable'];

// Model ids as they appear inside the CLI's own catalog.
const ID_PATTERN = /claude-(?:opus|sonnet|haiku|fable)-[0-9][0-9a-z-]*/g;

const PROBE_CONCURRENCY = 6;
const FAMILY_ORDER = ['opus', 'sonnet', 'haiku', 'fable'];

/** Absolute path of the binary we would spawn, following symlinks. */
async function resolveBinary(): Promise<string | null> {
  const candidates: string[] = [];
  if (CLAUDE_BIN.includes('/')) candidates.push(path.resolve(CLAUDE_BIN));
  else {
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      if (dir) candidates.push(path.join(dir, CLAUDE_BIN));
    }
  }
  for (const candidate of candidates) {
    try {
      await fsp.access(candidate, fs.constants.X_OK);
      return await fsp.realpath(candidate);
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * Scans the binary for model ids. This is where the installed version's catalog
 * lives, so the list tracks the CLI rather than anything hardcoded here. Every
 * hit is a candidate only — scanning also turns up junk, which the probe drops.
 */
async function scrapeCandidates(binary: string): Promise<string[]> {
  const found = new Set<string>();
  const stream = fs.createReadStream(binary, { encoding: 'latin1', highWaterMark: 4 << 20 });
  let carry = '';
  for await (const chunk of stream as AsyncIterable<string>) {
    const text = carry + chunk;
    for (const match of text.matchAll(ID_PATTERN)) found.add(match[0]);
    carry = text.slice(-64); // an id could straddle a chunk boundary
  }
  return [...found]
    .filter((id) => !id.endsWith('-v1')) // Bedrock/Vertex spellings, not selectable here
    .filter((id) => !/-\d{8}$/.test(id)); // date-pinned duplicates of the family id
}

/**
 * Asks the CLI whether it knows a model. An empty prompt makes it validate the
 * model and then bail out on the missing input, so this costs no tokens.
 */
function isKnownModel(model: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, ['-p', '', '--model', model], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let output = '';
    const collect = (chunk: Buffer): void => {
      output += chunk;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(!/model catalog/i.test(output));
    });
  });
}

async function filterKnown(candidates: string[]): Promise<string[]> {
  const known: string[] = [];
  for (let i = 0; i < candidates.length; i += PROBE_CONCURRENCY) {
    const batch = candidates.slice(i, i + PROBE_CONCURRENCY);
    const results = await Promise.all(batch.map(isKnownModel));
    batch.forEach((model, index) => {
      if (results[index]) known.push(model);
    });
  }
  return known;
}

/** "claude-haiku-4-5" becomes "Haiku 4.5"; "opus" becomes "Opus (latest)". */
function label(value: string): string {
  if (ALIASES.includes(value)) return `${value[0]!.toUpperCase()}${value.slice(1)} (latest)`;
  const parts = value.replace(/^claude-/, '').split('-');
  const family = parts.shift() ?? value;
  const words: string[] = [];
  let version: string[] = [];
  for (const part of parts) {
    if (/^\d+$/.test(part)) version.push(part);
    else {
      if (version.length) {
        words.push(version.join('.'));
        version = [];
      }
      words.push(`${part[0]!.toUpperCase()}${part.slice(1)}`);
    }
  }
  if (version.length) words.push(version.join('.'));
  return [`${family[0]!.toUpperCase()}${family.slice(1)}`, ...words].join(' ');
}

function sortModels(values: string[]): string[] {
  const familyIndex = (value: string): number => {
    const index = FAMILY_ORDER.findIndex((family) => value.includes(family));
    return index === -1 ? FAMILY_ORDER.length : index;
  };
  // Compare version parts one at a time, newest first: 5 beats 4.8.
  const parts = (value: string): number[] => (value.replace(/^claude-/, '').match(/\d+/g) ?? []).map(Number);
  const newestFirst = (a: string, b: string): number => {
    const [left, right] = [parts(a), parts(b)];
    for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
      const diff = (right[i] ?? -1) - (left[i] ?? -1);
      if (diff) return diff;
    }
    return 0;
  };

  const aliases = values.filter((v) => ALIASES.includes(v)).sort((a, b) => familyIndex(a) - familyIndex(b));
  const ids = values
    .filter((v) => !ALIASES.includes(v))
    .sort((a, b) => familyIndex(a) - familyIndex(b) || newestFirst(a, b) || a.localeCompare(b));
  return [...aliases, ...ids];
}

class ModelCatalog {
  public models: string[];
  public discoveredAt: string | null;
  public loading: boolean;
  public error: string | null;
  public inFlight: Promise<void> | null;

  public constructor() {
    this.models = [];
    this.discoveredAt = null;
    this.loading = false;
    this.error = null;
    this.inFlight = null;
  }

  public state(): ModelCatalogState {
    return {
      models: this.models.map((value) => ({ value, label: label(value) })),
      discoveredAt: this.discoveredAt,
      loading: this.loading,
      error: this.error,
    };
  }

  /** Concurrent callers share one discovery run. */
  public refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.loading = true;
    this.error = null;
    emit('models:loading');
    this.inFlight = this.discover()
      .catch((err: Error) => {
        this.error = err.message;
        console.error(`[models] discovery failed: ${err.message}`);
      })
      .finally(() => {
        this.loading = false;
        this.inFlight = null;
        emit('models:updated', { count: this.models.length, error: this.error });
      });
    return this.inFlight;
  }

  public async discover(): Promise<void> {
    const started = Date.now();
    const binary = await resolveBinary();
    let candidates = [...ALIASES];
    if (binary) {
      candidates = [...new Set([...ALIASES, ...(await scrapeCandidates(binary))])];
    } else {
      console.warn(`[models] could not resolve ${CLAUDE_BIN}; offering aliases only`);
    }

    const known = await filterKnown(candidates);
    if (!known.length) throw new Error(`${CLAUDE_BIN} recognised none of the ${candidates.length} candidates`);

    this.models = sortModels(known);
    this.discoveredAt = new Date().toISOString();
    console.log(
      `[models] ${this.models.length} of ${candidates.length} candidates recognised in ${Date.now() - started}ms`,
    );
  }
}

export const modelCatalog = new ModelCatalog();
export { label as modelLabel };

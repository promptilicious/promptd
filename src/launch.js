import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const STAMP = path.join(DIST, '.built');
const LOCK = path.join(ROOT, '.build.lock');
const STALE_LOCK_MS = 5 * 60 * 1000;
const BUILD_INPUTS = ['package-lock.json', 'tsconfig.base.json', 'tsconfig.build.json'];

function newestMtime(dir) {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(full));
    else if (entry.name.endsWith('.ts')) newest = Math.max(newest, fs.statSync(full).mtimeMs);
  }
  return newest;
}

function sourcesChangedSinceBuild() {
  const built = fs.statSync(STAMP, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  const inputs = BUILD_INPUTS.map((file) => fs.statSync(path.join(ROOT, file), { throwIfNoEntry: false })?.mtimeMs ?? 0);
  return Math.max(newestMtime(path.join(ROOT, 'src')), ...inputs) > built;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The hub and the node start together under launchd and npm start, and both
// find the same stale build; the lock makes the second wait for the first.
function acquireLock() {
  for (;;) {
    try {
      fs.mkdirSync(LOCK);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const age = Date.now() - (fs.statSync(LOCK, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if (age > STALE_LOCK_MS) fs.rmSync(LOCK, { recursive: true, force: true });
      else sleep(250);
    }
  }
}

export function ensureBuilt() {
  if (!sourcesChangedSinceBuild()) return;
  acquireLock();
  try {
    if (!sourcesChangedSinceBuild()) return;
    const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
    console.error('[launch] sources changed since the last build; compiling');
    execFileSync(process.execPath, [tsc, '-p', path.join(ROOT, 'tsconfig.build.json')], { cwd: ROOT, stdio: ['ignore', 2, 2] });
    fs.writeFileSync(STAMP, `${new Date().toISOString()}\n`);
  } finally {
    fs.rmSync(LOCK, { recursive: true, force: true });
  }
}

export async function start(entry) {
  ensureBuilt();
  await import(pathToFileURL(path.join(DIST, entry)).href);
}

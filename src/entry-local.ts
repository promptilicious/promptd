import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(DIR, '..');
const watching = process.argv.includes('--watch');
const watch = watching ? ['--watch'] : [];

const compiler: ChildProcess | null = watching
  ? spawn(
      process.execPath,
      [
        createRequire(import.meta.url).resolve('typescript/bin/tsc'),
        '-w',
        '-p',
        path.join(PROJECT_DIR, 'tsconfig.build.json'),
        '--preserveWatchOutput',
      ],
      { stdio: 'inherit', env: process.env },
    )
  : null;

const children: ChildProcess[] = ['entry-hub.js', 'entry-node.js'].map((entry) =>
  spawn(process.execPath, [...watch, path.join(DIR, entry)], { stdio: 'inherit', env: process.env }),
);

let exiting = false;
function stopAll(code: number): void {
  if (exiting) return;
  exiting = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  if (compiler && compiler.exitCode === null) compiler.kill('SIGTERM');
  process.exitCode = code;
}

for (const child of children) child.on('exit', (code, signal) => stopAll(code ?? (signal ? 1 : 0)));
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));

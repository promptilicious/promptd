import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch') ? ['--watch'] : [];

const children = ['server.js', 'node.js'].map((entry) =>
  spawn(process.execPath, [...watch, path.join(SRC, entry)], { stdio: 'inherit', env: process.env }),
);

let exiting = false;
function stopAll(code) {
  if (exiting) return;
  exiting = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  process.exitCode = code;
}

for (const child of children) child.on('exit', (code, signal) => stopAll(code ?? (signal ? 1 : 0)));
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));

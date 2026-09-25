import { clearAdminPassword, hashPassword, PASSWORD_HASH_ENV, setAdminPassword } from './auth.js';
import { closeDatabase, databaseTarget, migrate, openDatabase } from './db.js';

const MIN_LENGTH = 12;

function readHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let typed = '';
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === '\u0003') {
          stdin.setRawMode(false);
          stdout.write('\n');
          reject(new Error('cancelled'));
          return;
        }
        if (char === '\r' || char === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          resolve(typed);
          return;
        }
        if (char === '\u007f' || char === '\b') typed = typed.slice(0, -1);
        else typed += char;
      }
    };
    stdin.on('data', onData);
  });
}

async function readPiped(): Promise<string> {
  let text = '';
  for await (const chunk of process.stdin) text += String(chunk);
  return text.split('\n')[0]?.trim() ?? '';
}

async function askPassword(): Promise<string> {
  if (!process.stdin.isTTY) return readPiped();
  const first = await readHidden('New admin password: ');
  const second = await readHidden('Again: ');
  if (first !== second) throw new Error('the two passwords did not match');
  return first;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  if (args.has('--clear')) {
    openDatabase();
    await migrate();
    await clearAdminPassword();
    console.log(`Removed the admin password from ${databaseTarget().location}. A hub on 127.0.0.1 is open again; any other host refuses to start.`);
    return;
  }

  const password = await askPassword();
  if (password.length < MIN_LENGTH) throw new Error(`use at least ${MIN_LENGTH} characters`);

  if (args.has('--print-hash')) {
    console.log(await hashPassword(password));
    return;
  }

  openDatabase();
  await migrate();
  await setAdminPassword(password);
  console.log(`Saved the admin password to ${databaseTarget().location}. Existing sessions are signed out.`);
  if (process.env[PASSWORD_HASH_ENV]) {
    console.warn(`${PASSWORD_HASH_ENV} is set in this environment, and a hub started with it uses that instead.`);
  }
}

try {
  await main();
} catch (err) {
  console.error(`set-password: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
